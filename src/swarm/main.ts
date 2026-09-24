// swarm — hundreds of animated rats, to show what the framework can carry.
//
// Every rat is a rigged, animated entity. They share four generated variants
// and one pose cache (sprites only, at the clips' 12 fps and 16 headings), and
// the engine's crowd helper stamps them through the brick world on a budget:
// full rate near the camera, stepped like sprite animation further away, and
// only the bricks whose rats changed are touched and uploaded.
//
// Move the cursor over the field (or tap) and the rats near it scatter.
// ?count= sets how many (default 300, up to 2000). The overlay shows what it
// costs.

import { createRenderer, makeCamera, makePerf, makeRay, observeResize, resizeToDisplay, type Renderer } from "@voxolith/renderer";
import { hashSeed, seededRandom } from "@voxolith/renderer/core";
import { makeBrickStamper, PaletteAllocator, type Entity } from "@voxolith/engine";
import { makeAnimator, makeCrowd, type CrowdMember, type CrowdStats } from "@voxolith/engine/animation";
import { createInput, makeOrbitController, prepareSurface, recogniseGestures } from "@voxolith/engine/input";
import { atmosphereFrame, ATMOSPHERES, timeOfDay } from "@voxolith/engine/atmosphere";
import { generateTerrain } from "@voxolith/gen-terrain";
import { generateCreature, PRESETS } from "@voxolith/gen-creature";
import { boot, runLoop } from "../shared/boot";

const params = new URLSearchParams(location.search);
const COUNT = Math.max(1, Math.min(2000, Number(params.get("count") ?? 300)));
const SIZE = { x: 640, y: 72, z: 640 };
const seed = hashSeed(params.get("seed") ?? "swarm");

const app = await boot("swarm");
if (app) {
  const { gpu, canvas, info } = app;
  const rng = seededRandom(seed);

  // A broad, gentle meadow with a few ponds.
  const terrain = generateTerrain({ width: SIZE.x, depth: SIZE.z, height: SIZE.y, baseY: 12, relief: 4, featureSize: 160, waterLevel: 8, river: { enabled: false, width: 0, depth: 0, banks: 0, meander: 100 } }, seed);
  const palette = new PaletteAllocator(1);
  const { base: groundBase } = palette.allocate(terrain.roles, "terrain");
  const KINDS = ["rat", "grey rat", "lab rat", "black rat"];
  const variants: Entity[] = KINDS.map((k, i) => generateCreature(PRESETS[k], seededRandom(seed + i * 97), k).entity);
  const bases = variants.map((e, i) => palette.allocate(e.model.roles, KINDS[i]).base);

  const renderer: Renderer = await createRenderer(gpu, { size: SIZE, palette: palette.buildPalette(), materials: palette.buildMaterials() });
  renderer.setClipBounds([0, 0, 0], [SIZE.x - 1, SIZE.y - 1, SIZE.z - 1]);
  renderer.setQuality(gpu.software ? "low" : "medium");
  renderer.edit({ x0: 0, y0: 0, z0: 0, x1: SIZE.x - 1, y1: terrain.maxY(), z1: SIZE.z - 1 }, (cells, ox, oy, oz) => terrain.fillBrick(cells, ox, oy, oz, groundBase));
  const ground = (x: number, z: number) => terrain.heightAt(Math.max(0, Math.min(SIZE.x - 1, Math.round(x))), Math.max(0, Math.min(SIZE.z - 1, Math.round(z))));

  const crowd = makeCrowd({ stamper: makeBrickStamper(renderer, { size: SIZE }), near: 140, farFps: 6, freeze: 700, budgetMs: 5 });

  interface Rat extends CrowdMember { speed: number; turn: number; timer: number; panic: number; }
  const CLIPS = ["walk", "idle", "sniff", "run"];
  const rats: Rat[] = [];
  for (let i = 0; i < COUNT; i++) {
    const k = i % variants.length;
    const anim = makeAnimator(variants[k], "walk");
    anim.update(rng() * 3);
    let x = 0, z = 0;
    do { x = 30 + rng() * (SIZE.x - 60); z = 30 + rng() * (SIZE.z - 60); } while (terrain.waterAt(Math.round(x), Math.round(z)));
    rats.push({ id: i + 1, entity: variants[k], variant: KINDS[k], anim, base: bases[k], x, y: 0, z, yaw: rng() * Math.PI * 2, speed: 12, turn: 0, timer: rng() * 4, panic: 0 });
  }

  // --- camera, input, the scare point ---------------------------------------------
  const camera = makeCamera({ target: [SIZE.x / 2, 12, SIZE.z / 2], distance: 520, pitchDeg: 40, fovDeg: 42 });
  prepareSurface(canvas, { contextMenu: false });
  const input = createInput(canvas, { loop: { invalidate: () => loop.invalidate() } });
  const orbit = makeOrbitController(input, {
    yaw: 30, pitch: 40, distance: 520, distanceLimits: [60, 1100], pitchLimits: [10, 85], fovDeg: 42,
    target: [SIZE.x / 2, 12, SIZE.z / 2], pan: "secondary", panBounds: { minX: 0, maxX: SIZE.x, minZ: 0, maxZ: SIZE.z },
  });
  const frame = () => camera(orbit.yaw(), orbit.distance(), orbit.target(), orbit.pitch());
  let scare: { x: number; z: number; r: number } | null = null;
  const scareAt = (cx: number, cy: number, r: number) => {
    const { origin, dir } = makeRay(canvas, frame(), cx, cy);
    const hit = terrain.pick(origin, dir, { water: true });
    if (hit) scare = { x: hit[0], z: hit[2], r };
  };
  // Hover is cosmetic input the input layer does not track (it follows pressed pointers).
  canvas.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse" && e.buttons === 0) scareAt(e.clientX, e.clientY, 45); });
  canvas.addEventListener("pointerleave", () => { scare = null; });
  recogniseGestures(input, { tap: (t) => scareAt(t.x, t.y, 90) });

  // --- behaviour -----------------------------------------------------------------
  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  const think = (r: Rat, dt: number) => {
    if (scare) {
      const dx = r.x - scare.x, dz = r.z - scare.z, d = Math.hypot(dx, dz);
      if (d < scare.r) { r.panic = 1.5 + rng(); r.turn = Math.atan2(dx, dz); }
    }
    if (r.panic > 0) {
      r.panic -= dt;
      r.yaw += Math.max(-6 * dt, Math.min(6 * dt, wrap(r.turn - r.yaw)));
      r.speed = 42;
      r.anim.play("run", { fade: 0.1 });
      if (r.panic <= 0) r.timer = 0;
    } else {
      r.timer -= dt;
      if (r.timer <= 0) {
        const c = CLIPS[Math.floor(rng() * 3)];
        r.anim.play(c, { fade: 0.25 });
        r.speed = c === "walk" ? 12 : 0;
        r.turn = r.yaw + (rng() - 0.5) * 2.4;
        r.timer = 1.5 + rng() * 4;
      }
      if (r.speed > 0) r.yaw += Math.max(-1.5 * dt, Math.min(1.5 * dt, wrap(r.turn - r.yaw)));
    }
    if (r.speed > 0) {
      const nx = r.x + Math.sin(r.yaw) * r.speed * dt, nz = r.z + Math.cos(r.yaw) * r.speed * dt;
      if (nx < 20 || nz < 20 || nx > SIZE.x - 20 || nz > SIZE.z - 20 || terrain.waterAt(Math.round(nx), Math.round(nz))) {
        r.yaw += Math.PI * (0.6 + rng() * 0.8);
        r.turn = r.yaw;
      } else { r.x = nx; r.z = nz; }
    }
    r.y = ground(r.x, r.z) + 1;
    r.anim.update(dt);
  };

  // --- loop and overlay ------------------------------------------------------------
  const perf = makePerf({ enabled: params.has("perf"), scale: gpu.renderScale, minScale: gpu.software ? 0.25 : 0.4, retryAfterMs: Infinity });
  const sky = atmosphereFrame(timeOfDay(0.45), ATMOSPHERES.clear);
  let last = performance.now();
  const acc = { frames: 0, ms: 0, bakes: 0, bricks: 0, hits: 0, misses: 0, fpsT: performance.now() };
  let stats: CrowdStats | null = null;
  const loop = runLoop((now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t0 = performance.now();
    for (const r of rats) think(r, dt);
    const f = frame();
    stats = crowd.update(rats, f.camPos as [number, number, number]);
    acc.ms += performance.now() - t0;
    acc.frames++;
    acc.bakes += stats.bakes;
    acc.bricks += stats.bricks;
    perf.frame(now);
    gpu.renderScale = perf.scale();
    resizeToDisplay(gpu);
    renderer.render({ ...f, ...sky, time: now / 1000 });
  }, true);
  observeResize(canvas, loop);

  const overlay = () => {
    const now = performance.now(), secs = (now - acc.fpsT) / 1000;
    const n = Math.max(1, acc.frames), c = crowd.cache.stats();
    info.textContent =
      `${rats.length} rats · ${(acc.frames / secs).toFixed(0)} fps · ${(acc.ms / n).toFixed(1)} ms CPU/frame · ` +
      `${(acc.bakes / n).toFixed(1)} bakes/frame · cache ${c.entries} poses, ${((100 * c.hits) / Math.max(1, c.hits + c.misses)).toFixed(0)}% hits · ` +
      `${(acc.bricks / n).toFixed(0)} bricks, ${((acc.bricks / n) * 288 / 1024).toFixed(0)} KB/frame · hover or tap to scatter them`;
    Object.assign(acc, { frames: 0, ms: 0, bakes: 0, bricks: 0, fpsT: now });
  };
  setInterval(overlay, 1000);
  if (params.has("e2e")) Object.assign(window, { swarmStats: () => ({ rats: rats.length, running: rats.filter((r) => r.panic > 0).length, last: stats }), swarmScare: (x: number, y: number) => { scareAt(x, y, 90); const sc = scare as { x: number; z: number; r: number } | null; return sc ? rats.filter((r) => Math.hypot(r.x - sc.x, r.z - sc.z) < sc.r).length : -1; } });
}
