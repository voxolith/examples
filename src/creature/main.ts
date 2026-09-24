// creature — rigged, animated rats you can hurt.
//
// Every rat is a rigged entity from @voxolith/gen-creature, played and baked
// by @voxolith/engine/animation and moved through the brick world with the
// engine's makeBrickStamper. Poses are baked at the clips' 12 fps and 16
// headings and cached, so a rat costs a stamp, not a bake, most frames.
//
// Tap or click a rat: the first hit wounds it where you hit (the fur opens
// onto fat, flesh and bone), a second hit on a leg, the tail or the head
// takes it off and it flies as a gib, spattering blood that stays on the
// ground. Enough damage and the rat dies.
//
// The behaviour (wander, turn, sniff, flee, die) is this page's own; the
// engine only animates and stamps.

import {
  createRenderer,
  makeCamera,
  makePerf,
  makeRay,
  observeResize,
  resizeToDisplay,
  type Renderer,
  type Vec3,
} from "@voxolith/renderer";
import { hashSeed, seededRandom } from "@voxolith/renderer/core";
import { makeBrickStamper, PaletteAllocator, toSprite, type Entity, type EntityModel, type Rig, type Sprite } from "@voxolith/engine";
import {
  bakePose,
  invertRigid,
  makeAnimator,
  makePoseCache,
  mulAffine,
  poseMatrices,
  quatAxisAngle,
  quatMul,
  restPose,
  sampleClip,
  sever,
  transformPoint,
  wound,
  type Animator,
} from "@voxolith/engine/animation";
import { createInput, makeOrbitController, prepareSurface, recogniseGestures } from "@voxolith/engine/input";
import { atmosphereFrame, ATMOSPHERES, timeOfDay } from "@voxolith/engine/atmosphere";
import { generateTerrain } from "@voxolith/gen-terrain";
import { generateCreature, PRESETS, ROLE } from "@voxolith/gen-creature";
import { boot, runLoop } from "../shared/boot";

const params = new URLSearchParams(location.search);
const COUNT = Math.max(1, Math.min(40, Number(params.get("count") ?? 8)));
const SIZE = { x: 256, y: 96, z: 256 };
const seed = hashSeed(params.get("seed") ?? "rats");
const FPS = 12;
const YAWS = 16;

const app = await boot("creature");
if (app) {
  const { gpu, canvas, info } = app;
  const rng = seededRandom(seed);

  // --- ground ---------------------------------------------------------------
  const terrain = generateTerrain({ width: SIZE.x, depth: SIZE.z, height: SIZE.y, baseY: 14, relief: 5, featureSize: 90, waterLevel: 9, river: { enabled: false, width: 0, depth: 0, banks: 0, meander: 100 } }, seed);
  const palette = new PaletteAllocator(1);
  const { base: groundBase } = palette.allocate(terrain.roles, "terrain");

  // --- rats -----------------------------------------------------------------
  const KINDS = ["rat", "grey rat", "lab rat", "black rat"];
  const variants = KINDS.map((k, i) => generateCreature(PRESETS[k], seededRandom(seed + i * 101), k).entity);
  const bases = variants.map((e, i) => palette.allocate(e.model.roles, `creature:${KINDS[i]}`).base);

  const renderer: Renderer = await createRenderer(gpu, { size: SIZE, palette: palette.buildPalette(), materials: palette.buildMaterials() });
  renderer.setClipBounds([0, 0, 0], [SIZE.x - 1, SIZE.y - 1, SIZE.z - 1]);
  renderer.setQuality(gpu.software ? "low" : "medium");
  const maxY = terrain.maxY();
  renderer.edit({ x0: 0, y0: 0, z0: 0, x1: SIZE.x - 1, y1: maxY, z1: SIZE.z - 1 }, (cells, ox, oy, oz) => terrain.fillBrick(cells, ox, oy, oz, groundBase));
  const groundAt = (x: number, z: number) => terrain.heightAt(Math.max(0, Math.min(SIZE.x - 1, Math.round(x))), Math.max(0, Math.min(SIZE.z - 1, Math.round(z))));

  const stamper = makeBrickStamper(renderer, { size: SIZE });
  // Baked poses, as sprites, by variant / damage / clip / frame / heading.
  const cache = makePoseCache<{ model: EntityModel; sprite: Sprite; mats: Float32Array; yaw: number }>((v) => v.model.data.length * 2 + v.sprite.cells.length * 5);

  interface Rat {
    id: number;
    kind: number;
    entity: Entity;
    /** Rest model, carrying any damage. */
    rest: EntityModel;
    rig: Rig;
    damage: number;
    anim: Animator;
    x: number;
    z: number;
    yaw: number;
    state: "walk" | "idle" | "sniff" | "flee" | "dead";
    timer: number;
    tx: number;
    tz: number;
    hits: number;
    lost: Set<number>;
    last?: { model: EntityModel; mats: Float32Array; yaw: number; ox: number; oy: number; oz: number };
  }
  const rats: Rat[] = [];
  for (let i = 0; i < COUNT; i++) {
    const kind = i % variants.length;
    const e = variants[kind];
    rats.push({
      id: i + 1, kind, entity: e, rest: e.model, rig: e.rig!, damage: 0, anim: makeAnimator(e, "idle"),
      x: 60 + rng() * 136, z: 60 + rng() * 136, yaw: rng() * Math.PI * 2, state: "idle", timer: rng() * 2,
      tx: 0, tz: 0, hits: 0, lost: new Set(),
    });
  }

  // --- gibs and blood ---------------------------------------------------------
  interface Gib { id: number; model: EntityModel; rig: Rig; base: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; rot: [number, number, number, number]; spin: [number, number, number]; rest: boolean; }
  const gibs: Gib[] = [];
  interface Drop { x: number; y: number; z: number; vx: number; vy: number; vz: number; slot: number; }
  let drops: Drop[] = [];
  let nextId = 1000;
  const dropSprite: Sprite = { size: { x: 1, y: 1, z: 1 }, anchor: [0, 0, 0], cells: Int32Array.of(0), values: Uint8Array.of(1) };
  const dropIds: number[] = [];

  const splash = (x: number, y: number, z: number, slot: number, n: number) => {
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2, s = 6 + rng() * 14;
      drops.push({ x, y, z, vx: Math.cos(a) * s, vy: 8 + rng() * 14, vz: Math.sin(a) * s, slot });
    }
  };
  /** Paint a blood stain on the ground: a permanent edit of the top voxel. */
  const stain = (x: number, z: number, slot: number) => {
    const xi = Math.round(x), zi = Math.round(z);
    if (xi < 0 || zi < 0 || xi >= SIZE.x || zi >= SIZE.z) return;
    const y = groundAt(xi, zi);
    renderer.edit({ x0: xi, y0: y, z0: zi, x1: xi, y1: y, z1: zi }, (cells, ox, oy, oz) => {
      cells[(xi - ox) + (y - oy) * 8 + (zi - oz) * 64] = slot;
      return true;
    });
  };

  // --- camera and input ---------------------------------------------------------
  const camera = makeCamera({ target: [128, 20, 128], distance: 180, pitchDeg: 38, fovDeg: 40 });
  prepareSurface(canvas, { contextMenu: false });
  const input = createInput(canvas, { loop: { invalidate: () => loop.invalidate() } });
  const orbit = makeOrbitController(input, {
    yaw: 30, pitch: 38, distance: 170, distanceLimits: [40, 420], pitchLimits: [8, 85], fovDeg: 40,
    target: [128, 16, 128], pan: "secondary", panBounds: { minX: 0, maxX: SIZE.x, minZ: 0, maxZ: SIZE.z },
  });
  const frame = () => camera(orbit.yaw(), orbit.distance(), orbit.target(), orbit.pitch());

  /** The rat under a screen point, where exactly it was hit (world and rest space), and which bone. */
  const pick = (cx: number, cy: number) => {
    const { origin, dir } = makeRay(canvas, frame(), cx, cy);
    const l = Math.hypot(dir[0], dir[1], dir[2]);
    const d: Vec3 = [dir[0] / l, dir[1] / l, dir[2] / l];
    let best: { rat: Rat; t: number; bone: number; rest: Vec3; world: Vec3 } | null = null;
    for (const r of rats) {
      const L = r.last;
      if (!L) continue;
      const m = L.model, { x: sx, y: sy, z: sz } = m.size;
      // March the ray through this rat's posed box in half-voxel steps.
      for (let t = 0; t < 900; t += 0.5) {
        const px = origin[0] + d[0] * t - L.ox, py = origin[1] + d[1] * t - L.oy, pz = origin[2] + d[2] * t - L.oz;
        if (best && t > best.t) break;
        const x = Math.floor(px), y = Math.floor(py), z = Math.floor(pz);
        if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) continue;
        const i = x + y * sx + z * sx * sy;
        if (!m.data[i]) continue;
        const bone = m.bones![i];
        // Back to rest space: undo the heading and the bone's pose.
        const world = new Float32Array(12), inv = new Float32Array(12);
        const c = Math.cos(L.yaw), s = Math.sin(L.yaw), [ax, , az] = r.rest.anchor;
        const Y = new Float32Array([c, 0, s, ax - (c * ax + s * az), 0, 1, 0, 0, -s, 0, c, az - (-s * ax + c * az)]);
        mulAffine(Y, 0, L.mats, bone * 12, world, 0);
        invertRigid(world, 0, inv, 0);
        // Posed model space → rest model space (posed box origin sits at anchor offset).
        const pm: Vec3 = [x + 0.5 + (r.rest.anchor[0] - m.anchor[0]), y + 0.5 + (r.rest.anchor[1] - m.anchor[1]), z + 0.5 + (r.rest.anchor[2] - m.anchor[2])];
        const rest = transformPoint(inv, 0, pm[0], pm[1], pm[2], [0, 0, 0]);
        best = { rat: r, t, bone, rest, world: [origin[0] + d[0] * t, origin[1] + d[1] * t, origin[2] + d[2] * t] };
        break;
      }
    }
    return best;
  };

  const blood = (r: Rat) => bases[r.kind] + ROLE.BLOOD - 1;
  const severable = (r: Rat, bone: number): number | null => {
    // Walk up to the root of a limb, the tail or the head.
    let b = bone;
    while (b >= 0) {
      const id = r.rig.bones[b].id;
      if (id.endsWith(".upper") || id === "head" || id === "tail1") return b;
      if (["pelvis", "spine", "chest", "neck"].includes(id)) return null;
      b = r.rig.bones[b].parent;
    }
    return null;
  };
  const hit = (cx: number, cy: number) => {
    const h = pick(cx, cy);
    if (!h) return;
    const r = h.rat;
    r.hits++;
    const cut = r.hits > 1 ? severable(r, h.bone) : null;
    if (cut !== null && !r.lost.has(cut)) {
      const res = sever(r.rest, r.rig, cut, { rim: ROLE.BLOOD });
      r.rest = res.body;
      r.lost.add(cut);
      if (res.piece) {
        const a = rng() * Math.PI * 2;
        gibs.push({
          id: nextId++, model: res.piece.model, rig: res.piece.rig, base: bases[r.kind],
          x: h.world[0], y: h.world[1] + 1, z: h.world[2],
          vx: Math.cos(a) * 14, vy: 26 + rng() * 10, vz: Math.sin(a) * 14,
          rot: [0, 0, 0, 1], spin: [rng() * 8 - 4, rng() * 8 - 4, rng() * 8 - 4], rest: false,
        });
      }
      splash(h.world[0], h.world[1], h.world[2], blood(r), 26);
      if (r.rig.bones[cut].id === "head" || r.lost.size >= 3) die(r);
    } else {
      r.rest = wound(r.rest, h.rest, 2.2, { rim: ROLE.BLOOD });
      splash(h.world[0], h.world[1], h.world[2], blood(r), 12);
      if (r.hits >= 5) die(r);
      else if (r.state !== "dead") flee(r, h.world[0], h.world[2]);
    }
    r.damage++;
    loop.invalidate();
  };
  const die = (r: Rat) => {
    if (r.state === "dead") return;
    r.state = "dead";
    r.anim.play("death", { fade: 0.1 });
  };
  const flee = (r: Rat, fx: number, fz: number) => {
    r.state = "flee";
    r.timer = 1.6;
    const a = Math.atan2(r.x - fx, r.z - fz);
    r.tx = r.x + Math.sin(a) * 60;
    r.tz = r.z + Math.cos(a) * 60;
    r.anim.play("run", { fade: 0.12 });
  };
  recogniseGestures(input, { tap: (t) => hit(t.x, t.y) }, { longPressMs: 0 });

  // --- behaviour ---------------------------------------------------------------
  const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  const think = (r: Rat, dt: number) => {
    if (r.state === "dead") return;
    r.timer -= dt;
    const moving = r.state === "walk" || r.state === "flee";
    if (moving) {
      const want = Math.atan2(r.tx - r.x, r.tz - r.z);
      const turn = wrapAngle(want - r.yaw);
      const rate = r.state === "flee" ? 5 : 2.4;
      r.yaw += Math.max(-rate * dt, Math.min(rate * dt, turn));
      const speed = r.state === "flee" ? 38 : 13;
      r.x = Math.max(10, Math.min(SIZE.x - 10, r.x + Math.sin(r.yaw) * speed * dt));
      r.z = Math.max(10, Math.min(SIZE.z - 10, r.z + Math.cos(r.yaw) * speed * dt));
      if (r.state === "walk") r.anim.play(Math.abs(turn) > 0.35 ? (turn > 0 ? "turn-left" : "turn-right") : "walk", { fade: 0.2 });
      if (Math.hypot(r.tx - r.x, r.tz - r.z) < 4 || r.timer <= 0) {
        r.state = rng() < 0.5 ? "idle" : "sniff";
        r.timer = 1.5 + rng() * 2.5;
        r.anim.play(r.state, { fade: 0.25 });
      }
    } else if (r.timer <= 0) {
      r.state = "walk";
      const a = rng() * Math.PI * 2, d = 20 + rng() * 50;
      r.tx = Math.max(12, Math.min(SIZE.x - 12, r.x + Math.cos(a) * d));
      r.tz = Math.max(12, Math.min(SIZE.z - 12, r.z + Math.sin(a) * d));
      r.timer = 8;
      r.anim.play("walk", { fade: 0.2 });
    }
  };

  /** The rat's pose for this frame, from the cache: frame and heading are quantised. */
  const posed = (r: Rat) => {
    const clip = r.anim.clip();
    const f = Math.floor(r.anim.time() * FPS);
    const yb = ((Math.round((r.yaw / (Math.PI * 2)) * YAWS) % YAWS) + YAWS) % YAWS;
    const key = `${r.kind}.${r.id}.${r.damage}|${clip}|${f}|${yb}`;
    return cache.get(key, () => {
      const c = r.entity.clips!.find((k) => k.id === clip)!;
      const n = r.rig.bones.length;
      const mats = poseMatrices(r.rig, sampleClip(c, f / FPS, n));
      const yaw = (yb / YAWS) * Math.PI * 2;
      const model = bakePose(r.rest, r.rig, mats, { yaw });
      return { model, sprite: toSprite(model), mats, yaw };
    });
  };

  // --- loop ------------------------------------------------------------------------
  const perf = makePerf({ enabled: params.has("perf"), scale: gpu.renderScale, minScale: gpu.software ? 0.25 : 0.4, retryAfterMs: Infinity });
  const sky = atmosphereFrame(timeOfDay(0.42), ATMOSPHERES.clear);
  let last = performance.now(), stats = { bricks: 0, voxels: 0 };
  const loop = runLoop((now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    for (const r of rats) {
      think(r, dt);
      r.anim.update(dt);
      const p = posed(r);
      const y = groundAt(r.x, r.z) + 1;
      stamper.put(r.id, p.sprite, { x: r.x, y, z: r.z }, bases[r.kind]);
      r.last = { model: p.model, mats: p.mats, yaw: p.yaw, ox: Math.round(r.x - p.sprite.anchor[0]), oy: Math.round(y - p.sprite.anchor[1]), oz: Math.round(r.z - p.sprite.anchor[2]) };
    }
    // Gibs tumble, bounce, and come to rest where they land.
    for (const g of gibs) {
      if (g.rest) continue;
      g.vy -= 60 * dt;
      g.x += g.vx * dt; g.y += g.vy * dt; g.z += g.vz * dt;
      const ground = groundAt(g.x, g.z) + 1;
      if (g.y < ground) {
        g.y = ground;
        g.vy = -g.vy * 0.3; g.vx *= 0.6; g.vz *= 0.6;
        g.spin = [g.spin[0] * 0.5, g.spin[1] * 0.5, g.spin[2] * 0.5];
        if (Math.abs(g.vy) < 3) g.rest = true;
      }
      const sp = Math.hypot(...g.spin);
      if (sp > 0.01) g.rot = quatMul(quatAxisAngle(g.spin, sp * dt), g.rot);
      const pose = restPose(g.rig.bones.length);
      pose.rotations.set(g.rot, 0);
      const m = bakePose(g.model, g.rig, poseMatrices(g.rig, pose));
      stamper.put(g.id, toSprite(m), { x: g.x, y: g.y, z: g.z }, g.base);
    }
    // Blood drops fly, then stain the ground.
    drops = drops.filter((d, i) => {
      d.vy -= 60 * dt;
      d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
      const ground = groundAt(d.x, d.z);
      if (d.y <= ground + 1) { stain(d.x, d.z, d.slot); return false; }
      void i;
      return true;
    });
    while (dropIds.length < drops.length) dropIds.push(nextId++);
    dropIds.forEach((id, i) => {
      const d = drops[i];
      if (d) stamper.put(id, dropSprite, { x: d.x, y: d.y, z: d.z }, d.slot);
      else stamper.remove(id);
    });
    stats = stamper.commit();

    perf.frame(now);
    gpu.renderScale = perf.scale();
    resizeToDisplay(gpu);
    renderer.render({ ...frame(), ...sky, time: now / 1000 });
  }, true);
  observeResize(canvas, loop);

  // For the end-to-end checks (tools/input-e2e.ts): where each rat is drawn, and what happened to it.
  if (params.has("e2e")) {
    Object.assign(window, {
      creatureRats: () => rats.map((r) => {
        const f = frame();
        const p: Vec3 = [r.x, groundAt(r.x, r.z) + 6, r.z];
        const v = [p[0] - f.camPos[0], p[1] - f.camPos[1], p[2] - f.camPos[2]];
        const zc = v[0] * f.camFwd[0] + v[1] * f.camFwd[1] + v[2] * f.camFwd[2];
        const xc = (v[0] * f.camRight[0] + v[1] * f.camRight[1] + v[2] * f.camRight[2]) / zc;
        const yc = (v[0] * f.camUp[0] + v[1] * f.camUp[1] + v[2] * f.camUp[2]) / zc;
        const rect = canvas.getBoundingClientRect(), aspect = canvas.width / canvas.height;
        return {
          x: rect.left + ((xc / (aspect * f.tanHalfFov) + 1) / 2) * rect.width,
          y: rect.top + ((1 - yc / f.tanHalfFov) / 2) * rect.height,
          hits: r.hits, lost: r.lost.size, state: r.state,
        };
      }),
      creatureGibs: () => gibs.length,
      creatureFreeze: () => { for (const r of rats) { r.state = "idle"; r.timer = 1e9; r.anim.play("idle"); } },
    });
  }

  setInterval(() => {
    const c = cache.stats();
    const alive = rats.filter((r) => r.state !== "dead").length;
    info.textContent =
      `${alive}/${rats.length} rats · ${gibs.length} gibs · ${stats.bricks} bricks/frame · pose cache ${c.entries} (${((100 * c.hits) / Math.max(1, c.hits + c.misses)).toFixed(0)}% hits) · ` +
      `tap a rat to wound it, tap again to take a limb off`;
  }, 500);
}
