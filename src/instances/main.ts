// instances — scenery and a crowd drawn by reference, not stamped.
//
// Every tree here is one of six models uploaded once, placed hundreds of
// times at any heading; every rat is a pose model (one per variant, clip and
// frame, no heading buckets) placed at its exact position and yaw, so rats
// glide and turn smoothly and nothing is written into the world's bricks as
// they move. Compare the overlay's GPU memory with what stamping the same
// forest would cost (?stamp stamps the trees instead).
//
// ?trees= (default 160), ?rats= (default 400).

import { createRenderer, makeCamera, makePerf, observeResize, resizeToDisplay, type Renderer } from "@voxolith/renderer";
import { hashSeed, seededRandom } from "@voxolith/renderer/core";
import { blitModelToBricks, makeInstanceLayer, PaletteAllocator, type Entity, type Orientation } from "@voxolith/engine";
import { makeAnimator, makeCrowd, type CrowdMember } from "@voxolith/engine/animation";
import { createInput, makeOrbitController, prepareSurface } from "@voxolith/engine/input";
import { atmosphereFrame, ATMOSPHERES, timeOfDay } from "@voxolith/engine/atmosphere";
import { generateTerrain } from "@voxolith/gen-terrain";
import { generateTree, PRESETS as TREES } from "@voxolith/gen-tree";
import { generateCreature, PRESETS as RATS } from "@voxolith/gen-creature";
import { boot, runLoop } from "../shared/boot";

const params = new URLSearchParams(location.search);
const TREE_COUNT = Math.max(0, Math.min(2000, Number(params.get("trees") ?? 160)));
const RAT_COUNT = Math.max(0, Math.min(3000, Number(params.get("rats") ?? 400)));
const STAMP = params.has("stamp");
const SIZE = { x: 896, y: 176, z: 896 };
const seed = hashSeed(params.get("seed") ?? "instances");

const app = await boot("instances");
if (app) {
  const { gpu, canvas, info } = app;
  const rng = seededRandom(seed);
  const terrain = generateTerrain({ width: SIZE.x, depth: SIZE.z, height: SIZE.y, baseY: 12, relief: 6, featureSize: 200, waterLevel: 7, river: { enabled: false, width: 0, depth: 0, banks: 0, meander: 100 } }, seed);
  const palette = new PaletteAllocator(1);
  const { base: groundBase } = palette.allocate(terrain.roles, "terrain");

  // Six tree models: two of each species.
  const trees: { entity: Entity; base: number }[] = [];
  for (const [k, kind] of (["oak", "birch", "spruce"] as const).entries())
    for (let n = 0; n < 2; n++) {
      const p = structuredClone(TREES[kind]);
      p.shape.height = 90 + n * 30;
      const entity = generateTree(p, seededRandom(seed + k * 31 + n * 7)).entity;
      trees.push({ entity, base: palette.allocate(entity.model.roles, `${kind}${n}`).base });
    }
  const KINDS = ["rat", "grey rat", "lab rat", "black rat"];
  const rats: Entity[] = KINDS.map((k, i) => generateCreature(RATS[k], seededRandom(seed + i * 97), k).entity);
  const ratBase = rats.map((e, i) => palette.allocate(e.model.roles, KINDS[i]).base);

  const renderer: Renderer = await createRenderer(gpu, { size: SIZE, palette: palette.buildPalette(), materials: palette.buildMaterials() });
  renderer.setClipBounds([0, 0, 0], [SIZE.x - 1, SIZE.y - 1, SIZE.z - 1]);
  renderer.setQuality(gpu.software ? "low" : "medium");
  renderer.edit({ x0: 0, y0: 0, z0: 0, x1: SIZE.x - 1, y1: terrain.maxY(), z1: SIZE.z - 1 }, (cells, ox, oy, oz) => terrain.fillBrick(cells, ox, oy, oz, groundBase));
  const ground = (x: number, z: number) => terrain.heightAt(Math.max(0, Math.min(SIZE.x - 1, Math.round(x))), Math.max(0, Math.min(SIZE.z - 1, Math.round(z))));

  const layer = makeInstanceLayer(renderer);
  // Trees on dry ground, spaced, at any heading.
  const placed: { x: number; z: number }[] = [];
  const statics = [];
  for (let tries = 0; statics.length < TREE_COUNT && tries < TREE_COUNT * 30; tries++) {
    const x = 40 + rng() * (SIZE.x - 80), z = 40 + rng() * (SIZE.z - 80);
    if (terrain.waterAt(Math.round(x), Math.round(z)) || placed.some((p) => Math.hypot(p.x - x, p.z - z) < 38)) continue;
    placed.push({ x, z });
    const t = trees[Math.floor(rng() * trees.length)];
    statics.push({ model: t.entity.model, x: Math.round(x), y: ground(x, z) + 1, z: Math.round(z), yaw: rng() * Math.PI * 2, base: t.base });
  }
  if (STAMP) {
    // The old way, for comparison: every tree written into the world, turned in 90° steps.
    for (const s of statics) {
      blitModelToBricks(renderer, s.model, { x: s.x, y: s.y, z: s.z }, s.base, Math.floor((s.yaw / (Math.PI / 2)) % 4) as Orientation);
    }
  } else layer.setStatic(statics);

  // Rats wander between the trees.
  interface Rat extends CrowdMember { speed: number; turn: number; timer: number; }
  const crowd = makeCrowd({ instances: layer, near: 160, farFps: 6, freeze: 900, budgetMs: 5 });
  const members: Rat[] = [];
  for (let i = 0; i < RAT_COUNT; i++) {
    const k = i % rats.length;
    const anim = makeAnimator(rats[k], "walk");
    anim.update(rng() * 3);
    let x = 0, z = 0;
    do { x = 30 + rng() * (SIZE.x - 60); z = 30 + rng() * (SIZE.z - 60); } while (terrain.waterAt(Math.round(x), Math.round(z)));
    members.push({ id: i + 1, entity: rats[k], variant: KINDS[k], anim, base: ratBase[k], x, y: 0, z, yaw: rng() * Math.PI * 2, speed: 12, turn: 0, timer: rng() * 4 });
  }
  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  const think = (r: Rat, dt: number) => {
    r.timer -= dt;
    if (r.timer <= 0) {
      const c = ["walk", "walk", "idle", "sniff", "run"][Math.floor(rng() * 5)];
      r.anim.play(c, { fade: 0.25 });
      r.speed = c === "walk" ? 12 : c === "run" ? 36 : 0;
      r.turn = r.yaw + (rng() - 0.5) * 2.4;
      r.timer = 1.5 + rng() * 4;
    }
    if (r.speed > 0) {
      r.yaw += Math.max(-1.5 * dt, Math.min(1.5 * dt, wrap(r.turn - r.yaw)));
      const nx = r.x + Math.sin(r.yaw) * r.speed * dt, nz = r.z + Math.cos(r.yaw) * r.speed * dt;
      if (nx < 20 || nz < 20 || nx > SIZE.x - 20 || nz > SIZE.z - 20 || terrain.waterAt(Math.round(nx), Math.round(nz))) { r.yaw += Math.PI * 0.8; r.turn = r.yaw; }
      else { r.x = nx; r.z = nz; }
    }
    // Smooth height too: blend the ground under the rat.
    r.y = ground(r.x, r.z) + 1;
    r.anim.update(dt);
  };

  const camera = makeCamera({ target: [SIZE.x / 2, 20, SIZE.z / 2], distance: 420, pitchDeg: 38, fovDeg: 42 });
  prepareSurface(canvas, { contextMenu: false });
  const input = createInput(canvas, { loop: { invalidate: () => loop.invalidate() } });
  const orbit = makeOrbitController(input, {
    yaw: 30, pitch: 38, distance: 420, distanceLimits: [40, 1400], pitchLimits: [8, 85], fovDeg: 42,
    target: [SIZE.x / 2, 20, SIZE.z / 2], pan: "secondary", panBounds: { minX: 0, maxX: SIZE.x, minZ: 0, maxZ: SIZE.z },
  });
  const frame = () => camera(orbit.yaw(), orbit.distance(), orbit.target(), orbit.pitch());
  const perf = makePerf({ enabled: params.has("perf"), scale: gpu.renderScale, minScale: gpu.software ? 0.25 : 0.4, retryAfterMs: Infinity });
  const sky = atmosphereFrame(timeOfDay(0.42), ATMOSPHERES.clear);
  let last = performance.now();
  const acc = { frames: 0, ms: 0, t: performance.now() };
  const loop = runLoop((now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t0 = performance.now();
    for (const r of members) think(r, dt);
    const f = frame();
    crowd.update(members, f.camPos as [number, number, number]);
    if (!members.length) layer.commit();
    acc.ms += performance.now() - t0;
    acc.frames++;
    perf.frame(now);
    gpu.renderScale = perf.scale();
    resizeToDisplay(gpu);
    renderer.render({ ...f, ...sky, time: now / 1000 });
  }, true);
  observeResize(canvas, loop);
  setInterval(() => {
    const now = performance.now(), secs = (now - acc.t) / 1000, st = renderer.instanceStats();
    info.textContent = `${statics.length} trees ${STAMP ? "stamped" : "instanced"} · ${members.length} rats · ${st.instances} instances of ${st.models} models · ` +
      `${(acc.frames / secs).toFixed(0)} fps · ${(acc.ms / Math.max(1, acc.frames)).toFixed(1)} ms CPU · GPU voxels ${(st.bytes / 1048576).toFixed(0)} MB`;
    Object.assign(acc, { frames: 0, ms: 0, t: now });
  }, 1000);
  if (params.has("e2e")) Object.assign(window, { instancesStats: () => ({ ...renderer.instanceStats(), rats: members.length, trees: statics.length, first: { x: members[0]?.x, z: members[0]?.z, yaw: members[0]?.yaw } }) });
}
