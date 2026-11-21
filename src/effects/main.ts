// effects — a muzzle flash and an explosion, stamped into a scene and lit.
//
// A cannon, a brick wall, and dusk. Tap anywhere (or press Fire): the cannon
// flashes, a ball flies, and where it lands a blast carves a crater.
//
// `makeMuzzleFlash` and `makeExplosion` are simulations on a small stage grid
// of their own: `tick(dt)` rewrites `data`, whose values are seven fire-to-smoke
// slots. To put one in a scene the page copies the stage's voxels into the
// world each frame, at an offset, with the seven slots mapped to seven slots
// of the world's palette (the hot ones emissive).
//
// `GridStamper` does the copying: it keeps the static scene as a base plate,
// and each `stamp(voxels)` first restores what the previous stamp covered and
// then writes the new voxels, returning the box that changed for
// `renderer.updateVoxels`. So the flash, the ball and every blast go in as one
// list per frame and leave nothing behind. The crater is the other kind of
// edit, a permanent one to the base plate (`writeBase`).
//
// An emissive voxel only lights itself, so each effect also carries a point
// light (`renderer.setLights`) that fades with it: that is what lights the
// wall, the ground and the cannon.
//
// The page renders on demand, and continuously only while something burns.
//
// URL options (declared below; the HUD's Options panel changes them, all but the seed at once):
//   ?blast=medium        the explosion preset: small | medium | large
//   ?flash=cone          the muzzle flash: star | cone | bloom
//   ?auto                keep firing, about once a second
//   ?time=0.73           time of day, 0 midnight to 0.5 noon (default dusk, so the lights show)
//   ?seed=               where the Fire button's shots land
//   ?quality=, ?temporal=1, ?upscale=, ?reflections=0, ?renderScale=, ?debug=   the renderer's own
//   ?perf, ?full                                 the frame rate (and a phone's traced fraction); a phone gets the phone
//                                                profile (../shared/quality.ts), ?full the desktop settings
//   ?e2e                 window.effectsStats() and window.effectsFire() for the test tools

import { createRenderer, GridStamper, makeCamera, makeExplosion, makeMuzzleFlash, makeRay, observeResize, resizeToDisplay, voxelRaycast, type ExplosionSize, type MuzzleType, type PointLight, type StampVoxel, type Vec3, type VoxEffect } from "@voxolith/renderer";
import { hashSeed, seededRandom } from "@voxolith/renderer/core";
import { PaletteAllocator, trackRenderer, type Role } from "@voxolith/engine";
import { createInput, makeOrbitController, prepareSurface, recogniseGestures } from "@voxolith/engine/input";
import { atmosphereFrame, ATMOSPHERES, classicSky, timeOfDay } from "@voxolith/engine/atmosphere";
import { boot, runLoop } from "../shared/boot";
import { markFrames, prepared, reportLoadTimeline, step } from "../shared/loading";
import { STEPS } from "../shared/loading-screen";
import { defineOptions, OPTION, RENDER_OPTIONS, seedOption } from "../shared/options";
import { phoneProfile } from "../shared/scale";
import { applyRenderOptions } from "../shared/quality";

const options = defineOptions({
  blast: { kind: "choice", label: "Blast", help: "The explosion preset of the next shot: a bigger stage, a longer burn, a wider crater.", values: ["small", "medium", "large"], default: "medium", live: true, format: (v: string) => v[0].toUpperCase() + v.slice(1) },
  flash: { kind: "choice", label: "Muzzle flash", help: "The flash's shape: a flat star across the barrel, a forward jet, or a round pop.", values: ["star", "cone", "bloom"], default: "cone", live: true, format: (v: string) => v[0].toUpperCase() + v.slice(1) },
  auto: { kind: "toggle", label: "Auto fire", help: "Keep firing at the wall, about once a second.", default: false, live: true },
  time: { kind: "number", label: "Time of day", help: "0 midnight to 0.5 noon; the default is dusk, dark enough for the effects' lights to show.", min: 0, max: 1, step: 0.05, default: 0.73, live: true },
  seed: seedOption("effects"),
  ...RENDER_OPTIONS,
  e2e: OPTION.e2e,
});

/** How long each explosion preset burns before it would loop, in seconds, and its crater's radius in voxels. */
const BLAST: Record<ExplosionSize, { life: number; crater: number }> = { small: { life: 1.0, crater: 6 }, medium: { life: 1.7, crater: 9 }, large: { life: 2.6, crater: 13 } };
/** A muzzle flash lasts 0.13 s; then the effect would wait and repeat. */
const FLASH_S = 0.13, FLASH_STAGE = 40;

// The loading screen's rows, in this order.
const app = await boot("effects", {
  blurb: "A muzzle flash and an explosion, stamped and lit",
  steps: [STEPS.device, { phase: "scene", label: "Building the scene" }, STEPS.shaders, STEPS.pipelines],
  options,
});
if (app) {
  const { gpu, canvas, info, load, screen } = app;
  // A phone (../shared/scale.ts) gets the phone profile: the renderer's through applyRenderOptions below.
  const phone = phoneProfile(gpu, options);
  const rng = seededRandom(hashSeed(options.get("seed")));

  // --- palette: the scene's slots, then seven for the effects' fire ramp ----------------------
  const palette = new PaletteAllocator(1);
  const sceneRoles: Role[] = [
    { id: "grass", name: "Grass", color: [0.27, 0.42, 0.2] },
    { id: "soil", name: "Soil", color: [0.35, 0.26, 0.18] },
    { id: "brick", name: "Brick", color: [0.58, 0.27, 0.2] },
    { id: "brick.dark", name: "Brick dark", color: [0.47, 0.21, 0.16] },
    { id: "mortar", name: "Mortar", color: [0.66, 0.63, 0.57] },
    { id: "iron", name: "Iron", color: [0.14, 0.14, 0.16], material: { kind: "metal", rough: 0.45, metal: 0.9 } },
    { id: "wood", name: "Wood", color: [0.42, 0.29, 0.17] },
    { id: "scorch", name: "Scorched", color: [0.07, 0.06, 0.06] },
  ];
  const first = palette.allocate(sceneRoles, "scene").base;
  const [GRASS, SOIL, BRICK, BRICK_DARK, MORTAR, IRON, WOOD, SCORCH] = sceneRoles.map((_, i) => first + i);
  // Every effect uses the same ramp in slots 1 to 7 of its own palette: white-hot, yellow,
  // orange, red, deep red, then two smokes. Here they become world slots, the five hot ones emissive.
  const ramp = makeExplosion({ size: "small" }).palette;
  const fireRoles: Role[] = Array.from({ length: 7 }, (_, i) => ({
    id: `fire${i + 1}`, name: "Fire", color: [ramp[(i + 1) * 4], ramp[(i + 1) * 4 + 1], ramp[(i + 1) * 4 + 2]],
    ...(i < 5 ? { material: { kind: "emit" as const, emit: 5 - i * 0.8 } } : {}),
  }));
  const FIRE = palette.allocate(fireRoles, "fire").base;

  // --- the scene: ground, a cannon aimed along +x, a brick wall ---------------------------------
  const SIZE = { x: 192, y: 96, z: 128 };
  const TOP = 7, MUZZLE: Vec3 = [53, 21, 64];
  const base = await step(load, "scene", () => {
    const d = new Uint8Array(SIZE.x * SIZE.y * SIZE.z);
    const set = (x: number, y: number, z: number, v: number) => { d[x + y * SIZE.x + z * SIZE.x * SIZE.y] = v; };
    for (let z = 0; z < SIZE.z; z++) for (let x = 0; x < SIZE.x; x++) for (let y = 0; y <= TOP; y++) set(x, y, z, y === TOP ? GRASS : SOIL);
    // The wall: courses four voxels high, bricks eight long, every other course shifted.
    for (let z = 26; z <= 101; z++) for (let y = TOP + 1; y <= 58; y++) for (let x = 136; x <= 143; x++) {
      const course = Math.floor((y - TOP - 1) / 4), along = z + (course % 2) * 4;
      if (y > 52 && Math.floor(z / 6) % 2 === 0) continue; // battlements
      const mortar = (y - TOP - 1) % 4 === 3 || along % 8 === 7;
      set(x, y, z, mortar ? MORTAR : (course * 7 + Math.floor(along / 8) * 13) % 5 < 2 ? BRICK_DARK : BRICK);
    }
    // The cannon: a wooden carriage, two iron wheels, a barrel rising a little towards the wall.
    for (let x = 24; x <= 42; x++) for (let y = TOP + 6; y <= TOP + 9; y++) for (let z = 59; z <= 69; z++) set(x, y, z, WOOD);
    for (const z of [56, 57, 71, 72]) for (let x = -7; x <= 7; x++) for (let y = -7; y <= 7; y++) {
      const r = Math.hypot(x, y);
      if (r <= 7 && (r >= 5 || r < 1.5 || Math.abs(x) < 1 || Math.abs(y) < 1)) set(33 + x, TOP + 8 + y, z, IRON);
    }
    for (let x = 26; x <= 52; x++) {
      const cy = 17 + (x - 26) * 0.15, r = x < 30 ? 4.2 : 3.2;
      for (let y = -5; y <= 5; y++) for (let z = -5; z <= 5; z++) if (Math.hypot(y, z) <= r) set(x, Math.round(cy) + y, 64 + z, IRON);
    }
    return d;
  });
  // The stamper keeps `base` as the clean plate and composites into `liveData`, which is what is drawn.
  const stamper = new GridStamper(base, SIZE);
  const renderer = await createRenderer(gpu, { size: SIZE, data: stamper.liveData, palette: palette.buildPalette(), materials: palette.buildMaterials() }, { onLoad: trackRenderer(load), deferPipelines: true, background: classicSky });
  // Effects appear in what was empty air: clip rays to the whole grid, not to the scene as built.
  renderer.setClipBounds([0, 0, 0], [SIZE.x - 1, SIZE.y - 1, SIZE.z - 1]);
  // A CPU adapter (SwiftShader) starts on the Low preset, and draws small.
  const render = applyRenderOptions(options, renderer, { gpu, phone, preset: gpu.software ? "low" : "medium", changed: () => loop.invalidate() });
  const scale = gpu.software ? Math.min(gpu.renderScale, 0.3) : gpu.renderScale;
  await prepared(renderer.prepare());

  // --- what is in the air ----------------------------------------------------------------------
  /** A running effect: the simulation, where its stage's low corner sits in the world, and its light. */
  interface Burning { fx: VoxEffect; origin: Vec3; age: number; life: number; light: Vec3; power: number; shadows: boolean; }
  interface Ball { from: Vec3; to: Vec3; age: number; flight: number; size: ExplosionSize; }
  let burning: Burning[] = [];
  let balls: Ball[] = [];
  let shots = 0;

  const fire = (to: Vec3) => {
    shots++;
    // The flash's stage has its muzzle a third of the way along x, mid-height, firing towards +x.
    const flash = makeMuzzleFlash({ type: options.get("flash") as MuzzleType, size: FLASH_STAGE });
    burning.push({ fx: flash, origin: [MUZZLE[0] - Math.floor(FLASH_STAGE * 0.34), MUZZLE[1] - FLASH_STAGE / 2, MUZZLE[2] - FLASH_STAGE / 2], age: 0, life: FLASH_S, light: [MUZZLE[0] + 4, MUZZLE[1] + 12, MUZZLE[2]], power: 5, shadows: true });
    balls.push({ from: MUZZLE, to, age: 0, flight: Math.hypot(to[0] - MUZZLE[0], to[1] - MUZZLE[1], to[2] - MUZZLE[2]) / 320, size: options.get("blast") as ExplosionSize });
    loop.setContinuous(true);
  };
  const land = (b: Ball) => {
    const [cx, cy, cz] = b.to.map(Math.round), { life, crater: R } = BLAST[b.size];
    // The crater: a permanent edit of the base plate. Empty the ball of radius R, scorch what is left just outside it.
    const edits: StampVoxel[] = [];
    for (let z = -R - 2; z <= R + 2; z++) for (let y = -R - 2; y <= R + 2; y++) for (let x = -R - 2; x <= R + 2; x++) {
      const r = Math.hypot(x, y, z);
      if (r > R + 2 || cy + y < 1 || !stamper.baseAt(cx + x, cy + y, cz + z)) continue;
      edits.push({ x: cx + x, y: cy + y, z: cz + z, c: r <= R ? 0 : SCORCH });
    }
    const box = stamper.writeBase(edits);
    if (box) renderer.updateVoxels(stamper.liveData, box);
    // The blast sits on its stage's floor, in the middle: put that at the bottom of the crater.
    const fx = makeExplosion({ size: b.size });
    const floor = Math.max(1, cy - Math.round(R / 2));
    burning.push({ fx, origin: [cx - fx.size.x / 2, floor, cz - fx.size.z / 2], age: 0, life, light: [cx - 4, floor + R + 6, cz], power: 9, shadows: false });
    // Three blasts at once is plenty: each is a stage of up to two million cells to copy per frame.
    const blasts = burning.filter((e) => e.life > FLASH_S);
    if (blasts.length > 3) burning = burning.filter((e) => e !== blasts[0]);
  };

  // --- camera and loop -------------------------------------------------------------------------
  let sky = atmosphereFrame(timeOfDay(options.get("time")), ATMOSPHERES.clear);
  const target: Vec3 = [100, 26, 64];
  const camera = makeCamera({ target, distance: 250, pitchDeg: 14, fovDeg: 42 });
  prepareSurface(canvas, { contextMenu: false });
  const input = createInput(canvas, { loop: { invalidate: () => loop.invalidate() } });
  const orbit = makeOrbitController(input, { yaw: 345, pitch: 14, distance: 250, distanceLimits: [60, 500], pitchLimits: [4, 85], fovDeg: 42, target });
  const frame = () => camera(orbit.yaw(), orbit.distance(), orbit.target(), orbit.pitch());
  let sinceShot = 0, stamped = 0;
  const loop = runLoop((now, dtRaw) => {
    const dt = Math.min(0.05, dtRaw);
    if (options.get("auto") && (sinceShot += dt) > 1.1) { sinceShot = 0; fireAtWall(); }
    // Advance everything, and collect this frame's voxels in one list.
    const voxels: StampVoxel[] = [];
    for (const b of balls) {
      b.age += dt;
      if (b.age >= b.flight) { land(b); continue; }
      const k = b.age / b.flight, p = b.from.map((v, i) => Math.round(v + (b.to[i] - v) * k));
      for (let i = 0; i < 27; i++) voxels.push({ x: p[0] + (i % 3) - 1, y: p[1] + (Math.floor(i / 3) % 3) - 1, z: p[2] + Math.floor(i / 9) - 1, c: IRON });
    }
    balls = balls.filter((b) => b.age < b.flight);
    const lights: PointLight[] = [];
    for (const e of burning) {
      e.fx.tick(dt);
      e.age += dt;
      if (e.age >= e.life) continue;
      // The stage's voxels into the world: offset by the origin, fire slot n to world slot FIRE + n - 1.
      const { x: sx, y: sy } = e.fx.size, d = e.fx.data;
      for (let i = 0; i < d.length; i++) {
        if (d[i]) voxels.push({ x: e.origin[0] + (i % sx), y: e.origin[1] + (Math.floor(i / sx) % sy), z: e.origin[2] + Math.floor(i / (sx * sy)), c: FIRE + d[i] - 1 });
      }
      // A light that goes out with the fire (emissive voxels light only themselves). The flash's
      // hangs above the muzzle and casts the cannon's shadow; a blast's sits inside the fire, whose
      // own voxels would shadow it, so it casts none.
      const fade = (1 - e.age / e.life) ** 2;
      lights.push({ position: e.light, color: [1, 0.62, 0.28], intensity: e.power * fade, range: 150, shadows: e.shadows });
    }
    burning = burning.filter((e) => e.age < e.life);
    // One stamp for everything that moves: it restores last frame's cells first.
    const box = stamper.stamp(voxels);
    if (box) renderer.updateVoxels(stamper.liveData, box);
    stamped = voxels.length;
    renderer.setLights(lights);
    loop.setContinuous(options.get("auto") || burning.length > 0 || balls.length > 0);
    gpu.renderScale = render.pace(now, scale);
    resizeToDisplay(gpu);
    renderer.render({ ...frame(), ...sky });
  }, options.get("auto"), () => renderer.converging());
  observeResize(canvas, loop);

  // --- aiming ------------------------------------------------------------------------------------
  /** Where a ray first meets the static scene (the base plate, so nobody shoots at smoke). */
  const hitAlong = (origin: Vec3, dir: Vec3): Vec3 | null => {
    const hit = voxelRaycast(SIZE, base, origin, dir, 4096);
    return hit ? [origin[0] + dir[0] * hit.t, origin[1] + dir[1] * hit.t, origin[2] + dir[2] * hit.t] : null;
  };
  const fireAtWall = () => {
    const aim: Vec3 = [140, 14 + rng() * 36, 32 + rng() * 64];
    fire(hitAlong(MUZZLE, [aim[0] - MUZZLE[0], aim[1] - MUZZLE[1], aim[2] - MUZZLE[2]]) ?? aim);
  };
  // A tap is a press released without dragging (the orbit controller takes the drags).
  recogniseGestures(input, {
    tap: (t) => {
      if (t.button !== 0) return;
      const { origin, dir } = makeRay(canvas, frame(), t.x, t.y);
      const at = hitAlong(origin, dir);
      if (at) fire(at);
    },
  }, { longPressMs: 0 });

  // --- HUD -----------------------------------------------------------------------------------
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
  const blastSel = $<HTMLSelectElement>("blast"), flashSel = $<HTMLSelectElement>("flash"), autoBtn = $<HTMLButtonElement>("auto-toggle");
  const sync = () => {
    if (blastSel) blastSel.value = options.get("blast");
    if (flashSel) flashSel.value = options.get("flash");
    if (autoBtn) { autoBtn.textContent = `Auto: ${options.get("auto") ? "on" : "off"}`; autoBtn.setAttribute("aria-pressed", String(options.get("auto"))); }
    loop.setContinuous(options.get("auto") || burning.length > 0 || balls.length > 0);
    loop.invalidate();
  };
  $("fire")?.addEventListener("click", fireAtWall);
  blastSel?.addEventListener("change", () => { options.sync("blast", blastSel.value as ExplosionSize); sync(); });
  flashSel?.addEventListener("change", () => { options.sync("flash", flashSel.value as MuzzleType); sync(); });
  autoBtn?.addEventListener("click", () => { options.sync("auto", !options.get("auto")); sync(); });
  for (const key of ["blast", "flash", "auto"] as const) options.on(key, sync);
  options.on("time", (t) => { sky = atmosphereFrame(timeOfDay(t), ATMOSPHERES.clear); loop.invalidate(); });
  input.captureKeys(["Space"]);
  input.on((e) => { if (e.kind === "key" && e.phase === "down" && e.code === "Space" && !e.repeat) fireAtWall(); });
  setInterval(() => {
    info.textContent = `${shots} shots · ${burning.length} effects burning, ${stamped.toLocaleString()} voxels stamped this frame · tap the scene to fire at it (Space: at the wall) · drag to turn`;
  }, 250);

  if (options.get("e2e")) Object.assign(window, { effectsStats: () => ({ shots, burning: burning.length, balls: balls.length, stamped }), effectsFire: fireAtWall });

  sync();
  screen.ready();
  markFrames(load, renderer);
  void reportLoadTimeline(load, { perf: false });
}
