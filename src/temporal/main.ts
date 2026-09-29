// temporal — what temporal accumulation of shadows and AO costs and saves.
//
// A small patch of ground at 10 voxels per metre (a cottage, a few trees and
// rocks, two lamps) at night, built in well under a second on a desktop, so
// the page suits a phone. The moon is the key light (brightened and bluer than
// the engine's night, and 34° up so its shadows fall across the ground); the
// cottage's windows are lit, and two lamp posts hang a point light each off an
// arm, so their pools of light carry the pole's, the props' and the cottage
// corner's shadows. `RenderQuality.temporal` keeps the moon's shadow, the AO
// and the lamps' shadows per pixel across frames and stops tracing them once
// they have converged; the button (or T) turns it off and on, and the readout
// shows fps, GPU milliseconds per frame (from timestamp queries, when the
// device has them), the fixed render scale, and whether the history has
// converged. The last GPU time seen with it off and with it on stay side by
// side, so one tap gives a comparison. The Moon select is the key light's
// angular radius (lightAngle): soft shadow edges with temporal on.
//
// The page renders on demand: a still view with temporal on draws until the
// history has converged, then stops. Opening the page and each toggle draw a
// short burst of frames (40) so each mode's GPU time settles and is kept.
// "Redraw: always" keeps drawing every frame, to read what a still frame costs
// once converged; "Rotate" turns the camera, to read what a moving view costs.
// The render scale is fixed (no adaptive scaling), so the numbers compare.
//
// URL options:
//   ?temporal=1          open with temporal accumulation on (default off)
//   ?rotate              open auto-rotating
//   ?always              open redrawing every frame
//   ?renderScale=0.5     fixed render scale, 0.1-1 (default 0.8; 0.5 on a phone, 0.3 on a CPU adapter)
//   ?quality=medium      low | medium | high (default medium; low on a CPU adapter, where temporal has
//                        nothing to accumulate, so pass ?quality=medium to exercise it there)
//   ?angle=0.02          the moon's angular radius in radians (soft shadow edges with temporal on)
//   ?time=0.1            time of day, 0 midnight to 0.5 noon (default 0.1, night with the moon 34° up;
//                        0.98 is nightwood's higher moon; by day the sun and sky are the engine's own)
//   ?ambient=1           sky light, as a multiple of the engine's own for that time (lower: darker shadows)
//   ?yaw=305             the camera's starting heading in degrees
//   ?show=1 | ?show=2    the renderer's development views: tiles traced / samples per pixel
//   ?full                desktop settings on a phone
//   ?e2e                 window.temporalStats() and window.temporalSet({ temporal, rotate, always, angle })

import {
  createRenderer,
  makeCamera,
  makeFrameLoop,
  observeResize,
  QUALITY_PRESETS,
  resizeToDisplay,
  type PointLight,
  type QualityPreset,
  type Renderer,
  type Vec3,
} from "@voxolith/renderer";
import { hashSeed, seededRandom } from "@voxolith/renderer/core";
import { blitModelToBricks, PaletteAllocator, trackRenderer, type Entity, type Orientation, type Role } from "@voxolith/engine";
import { createInput, makeOrbitController, prepareSurface } from "@voxolith/engine/input";
import { atmosphereFrame, ATMOSPHERES, timeOfDay } from "@voxolith/engine/atmosphere";
import { generateTerrain } from "@voxolith/gen-terrain";
import { generateTree, PRESETS as TREES } from "@voxolith/gen-tree";
import { generateRock, PRESETS as ROCKS } from "@voxolith/gen-rock";
import { generateBuilding, PRESETS as BUILDINGS } from "@voxolith/gen-building";
import { boot } from "../shared/boot";
import { markFrames, nextFrame, prepared, reportLoadTimeline, step } from "../shared/loading";
import { STEPS } from "../shared/loading-screen";
import { isPhone } from "../shared/scale";

const params = new URLSearchParams(location.search);
const num = (k: string, d: number) => {
  const v = Number(params.get(k));
  return params.has(k) && Number.isFinite(v) ? v : d;
};
// 32 m square: small enough to build in a moment on a phone.
const SIZE = { x: 320, y: 128, z: 320 };
const C = SIZE.x / 2;
const seed = hashSeed(params.get("seed") ?? "temporal");
const show = num("show", 0);
if (show) (globalThis as { __voxolithTemporal?: object }).__voxolithTemporal = { show };

// Night, lit by the moon. timeOfDay's own moonlight is too dim to judge
// shadows by, so it is brightened and turned bluer per channel (nightwood's
// recipe, turned down a little so the lamps' pools still stand out). The sky
// light is the engine's own night ambient, unscaled (?ambient= multiplies it):
// dark enough that the ground outside the moonlight and the lamps stays dark.
// The moon stands at 0.1 rather than nightwood's 0.98: the same night (same
// colours and sky light), with the moon 34° up instead of 58°, so it lights
// the cottage's gable and throws shadows across the ground rather than under
// things. The boost fades with the engine's night factor, so a daytime ?time=
// is the engine's own.
const NIGHT = 0.1;
const MOONLIGHT: Vec3 = [1.6, 1.9, 2.4];
function lighting(phase: number, ambient: number) {
  const t = timeOfDay(phase);
  const k = (i: number) => 1 + (MOONLIGHT[i] - 1) * t.nightFactor;
  t.lightColor = [t.lightColor[0] * k(0), t.lightColor[1] * k(1), t.lightColor[2] * k(2)];
  t.ambientSky = t.ambientSky.map((c) => c * ambient) as Vec3;
  t.ambientGround = t.ambientGround.map((c) => c * ambient) as Vec3;
  return atmosphereFrame(t, ATMOSPHERES.clear);
}

// The loading screen's rows, in this order (phases not listed are not shown, but stay on the
// tracker for window.loadTimeline and ?perf).
const app = await boot("temporal", {
  blurb: "Shadows and AO accumulated over frames",
  steps: [
    STEPS.device,
    { phase: "terrain", label: "Shaping the terrain" },
    STEPS.models,
    STEPS.shaders,
    STEPS.pipelines,
    { phase: "scene", label: "Building the scene" },
  ],
});
if (app) {
  const { gpu, canvas, info, load, screen } = app;
  const t0 = performance.now();
  const phone = isPhone(gpu, params);
  const rng = seededRandom(seed);

  // --- ground ------------------------------------------------------------------
  // Low hills, no water (water animates, and would keep the page drawing).
  const terrain = await step(load, "terrain", () => generateTerrain({ width: SIZE.x, depth: SIZE.z, height: SIZE.y, baseY: 14, relief: 5, featureSize: 150, waterLevel: 2, river: { enabled: false, width: 0, depth: 0, banks: 0, meander: 100 } }, seed));
  const H = terrain.heights, W = SIZE.x;
  const hAt = (x: number, z: number) => H[Math.max(0, Math.min(W - 1, Math.round(x))) + Math.max(0, Math.min(SIZE.z - 1, Math.round(z))) * W];
  // A level pad for the cottage, blended into the hills over 12 voxels.
  const pad = hAt(C, C);
  for (let z = 0; z < SIZE.z; z++)
    for (let x = 0; x < W; x++) {
      const d = Math.max(Math.abs(x - C) - 50, Math.abs(z - C) - 40, 0);
      if (d < 12) H[x + z * W] = Math.round(pad + (H[x + z * W] - pad) * (d / 12));
    }

  // --- models --------------------------------------------------------------------
  const palette = new PaletteAllocator(1);
  const { base: groundBase } = palette.allocate(terrain.roles, "terrain");
  const lampRoles: Role[] = [{ id: "iron", name: "Lamp post", color: [0.12, 0.12, 0.13], material: { kind: "metal", rough: 0.5, metal: 0.8 } }];
  const { base: lampBase } = palette.allocate(lampRoles, "lamp");
  const place: { entity: Entity; base: number; x: number; z: number; o: Orientation }[] = [];
  const add = (entity: Entity, key: string, x: number, z: number, o: Orientation = 0) => {
    const base = palette.allocate(entity.model.roles, key).base;
    place.push({ entity, base, x, z, o });
  };
  // Generated on the main thread, eleven models, counted as they come.
  const models = load.task("models", 11);
  await nextFrame();
  // The cottage with every window lit, so it glows in the dark (as in nightwood).
  const cottage = structuredClone(BUILDINGS.cottage);
  cottage.look.lit = 1;
  add(generateBuilding(cottage, seededRandom(seed + 1)).entity, "cottage", C, C, 0);
  models.tick();
  // Six trees on a ring round the cottage, two of each kind.
  const kinds = ["oak", "birch", "spruce"] as const;
  for (let i = 0; i < 6; i++) {
    const p = structuredClone(TREES[kinds[i % 3]]);
    p.shape.height = 70 + Math.round(rng() * 30);
    const a = (i / 6) * Math.PI * 2 + 0.4 + rng() * 0.5, r = 88 + rng() * 40;
    add(generateTree(p, seededRandom(seed + 10 + i)).entity, `tree${i}`, C + Math.cos(a) * r, C + Math.sin(a) * r);
    models.tick();
  }
  const rocks = ["boulder", "mossy", "sandstone", "pebbles"];
  for (let i = 0; i < rocks.length; i++) {
    const a = (i / rocks.length) * Math.PI * 2 + 1.2, r = 62 + rng() * 14;
    add(generateRock(ROCKS[rocks[i]], seededRandom(seed + 20 + i)).entity, `rock${i}`, C + Math.cos(a) * r * 1.2, C + Math.sin(a) * r);
    models.tick();
  }
  models.end();

  // --- renderer ----------------------------------------------------------------------
  const renderer: Renderer = await createRenderer(gpu, { size: SIZE, palette: palette.buildPalette(), materials: palette.buildMaterials() }, { onLoad: trackRenderer(load), deferPipelines: true });
  renderer.setClipBounds([0, 0, 0], [SIZE.x - 1, SIZE.y - 1, SIZE.z - 1]);
  const asked = params.get("quality") as QualityPreset | null;
  const quality: QualityPreset = asked && asked in QUALITY_PRESETS ? asked : gpu.software ? "low" : "medium";
  let temporal = params.get("temporal") === "1";
  renderer.setQuality({ ...QUALITY_PRESETS[quality], temporal });
  // Temporal accumulates the shadows and AO; the Low preset has neither.
  const canAccumulate = QUALITY_PRESETS[quality].shadowSteps > 0 || QUALITY_PRESETS[quality].ao;
  gpu.renderScale = Math.max(0.1, Math.min(1, num("renderScale", gpu.software ? 0.3 : phone ? 0.5 : gpu.renderScale)));
  // deferPipelines above: compile the pipelines of the mode the page opens in while the scene is
  // built, and await them before the first frame. The other mode's compile after the first picture.
  const compiled = prepared(renderer.prepare({ temporal }));

  await step(load, "scene", () => {
    renderer.edit({ x0: 0, y0: 0, z0: 0, x1: SIZE.x - 1, y1: terrain.maxY(), z1: SIZE.z - 1 }, (cells, ox, oy, oz) => terrain.fillBrick(cells, ox, oy, oz, groundBase));
    for (const p of place) blitModelToBricks(renderer, p.entity.model, { x: Math.round(p.x), y: hAt(p.x, p.z) + 1, z: Math.round(p.z) }, p.base, p.o);
  });

  // Two lamp posts: a 2x2 iron pole with an arm reaching towards the cottage
  // and a point light hanging under its end, drawn by its glow. The light
  // stands off the pole, so the pole throws a shadow across the ground away
  // from it. (A solid lantern round the light would shadow the ground below.)
  const lamps: Vec3[] = [];
  const iron = (box: { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }) =>
    renderer.edit(box, (cells, ox, oy, oz) => {
      let changed = false;
      for (let i = 0; i < 512; i++) {
        const vx = ox + (i & 7), vy = oy + ((i >> 3) & 7), vz = oz + (i >> 6);
        if (vx < box.x0 || vx > box.x1 || vy < box.y0 || vy > box.y1 || vz < box.z0 || vz > box.z1) continue;
        cells[i] = lampBase;
        changed = true;
      }
      return changed;
    });
  const ARM = 6;
  const lampPost = (x: number, z: number, tall: number, dx: number, dz: number) => {
    const y0 = hAt(x, z) + 1, top = y0 + tall;
    iron({ x0: x, y0, z0: z, x1: x + 1, y1: top - 1, z1: z + 1 });
    const ex = x + dx * ARM, ez = z + dz * ARM;
    iron({ x0: Math.min(x, ex), y0: top - 1, z0: Math.min(z, ez), x1: Math.max(x, ex) + 1, y1: top - 1, z1: Math.max(z, ez) + 1 });
    lamps.push([ex + 1, top - 3.5, ez + 1]);
  };
  lampPost(Math.round(C + 22), Math.round(C + 46), 24, 0, -1);
  lampPost(Math.round(C - 64), Math.round(C - 12), 20, 1, 0);
  const lights: PointLight[] = lamps.map((position) => ({ position, color: [1.0, 0.7, 0.4], intensity: 4, range: 100, glow: 3 }));
  renderer.setLights(lights);

  // --- camera and loop ------------------------------------------------------------------
  const phase = num("time", NIGHT);
  const sky = lighting(phase, Math.max(0, num("ambient", 1)));
  let lightAngle = Math.max(0, Math.min(0.2, num("angle", 0.02)));
  let rotate = params.has("rotate");
  let always = params.has("always");
  // Start further out on a portrait screen, whose horizontal view is narrow.
  const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
  const dist0 = Math.round(300 * Math.min(1.8, Math.max(1, 0.75 / aspect)));
  const camera = makeCamera({ target: [C, pad + 24, C], distance: dist0, pitchDeg: 30, fovDeg: 42 });
  prepareSurface(canvas, { contextMenu: false });
  const input = createInput(canvas, { loop: { invalidate: () => loop.invalidate() } });
  const orbit = makeOrbitController(input, {
    yaw: num("yaw", 305), pitch: 30, distance: dist0, distanceLimits: [60, 700], pitchLimits: [6, 85], fovDeg: 42,
    target: [C, pad + 24, C], pan: "secondary", panBounds: { minX: 0, maxX: SIZE.x, minZ: 0, maxZ: SIZE.z },
  });

  // Frames rendered since the last readout, and since temporal was last toggled.
  // Opening the page and each toggle draw a burst of BURST frames even when
  // nothing changes, so the GPU time of either mode settles and is recorded.
  const BURST = 40;
  let frames = 0, sinceToggle = 0;
  await compiled;
  const loop = makeFrameLoop({
    render: (_now, dt) => {
      resizeToDisplay(gpu);
      if (rotate) orbit.set({ yaw: orbit.yaw() + dt * 10 });
      renderer.render({ ...camera(orbit.yaw(), orbit.distance(), orbit.target(), orbit.pitch()), ...sky, lightAngle });
      frames++;
      sinceToggle++;
    },
    // Keep drawing while the history converges (and through a measuring burst), then go idle.
    converging: () => renderer.converging() || sinceToggle < BURST,
  });
  observeResize(canvas, loop);
  const syncLoop = () => loop.setContinuous(rotate || always);

  // --- HUD ------------------------------------------------------------------------------
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
  const temporalBtn = $<HTMLButtonElement>("temporal-toggle");
  const rotateBtn = $<HTMLButtonElement>("rotate-toggle");
  const redrawBtn = $<HTMLButtonElement>("redraw-toggle");
  const angleSel = $<HTMLSelectElement>("angle");
  const readout = $<HTMLElement>("readout");
  const sync = () => {
    if (temporalBtn) {
      temporalBtn.textContent = canAccumulate ? `Temporal: ${temporal ? "on" : "off"}` : "Temporal: n/a";
      temporalBtn.setAttribute("aria-pressed", String(temporal));
      temporalBtn.title = canAccumulate ? "Temporal accumulation of shadows and AO (T)" : "The low preset has no shadows or AO to accumulate (try ?quality=medium)";
    }
    if (rotateBtn) { rotateBtn.textContent = `Rotate: ${rotate ? "on" : "off"}`; rotateBtn.setAttribute("aria-pressed", String(rotate)); }
    if (redrawBtn) { redrawBtn.textContent = `Redraw: ${always ? "always" : "on demand"}`; redrawBtn.setAttribute("aria-pressed", String(always)); }
    if (angleSel) angleSel.value = String(lightAngle);
  };
  const setTemporal = (on: boolean) => {
    if (on === temporal) return;
    temporal = on;
    renderer.setQuality({ ...renderer.getQuality(), temporal });
    sinceToggle = 0;
    sync();
    loop.invalidate();
  };
  temporalBtn?.addEventListener("click", () => setTemporal(!temporal));
  rotateBtn?.addEventListener("click", () => { rotate = !rotate; sync(); syncLoop(); });
  redrawBtn?.addEventListener("click", () => { always = !always; sync(); syncLoop(); });
  if (angleSel) {
    // The moon's angular radius: soft penumbrae with temporal on, hard shadows without.
    const angles: [number, string][] = [[0.005, "Moon 0.3°"], [0.02, "Moon 1.1°"], [0.05, "Moon 2.9°"], [0.1, "Moon 5.7°"]];
    if (!angles.some(([a]) => a === lightAngle)) angles.push([lightAngle, `Moon ${((lightAngle * 180) / Math.PI).toFixed(1)}°`]);
    for (const [a, label] of angles) angleSel.append(new Option(label, String(a)));
    angleSel.addEventListener("change", () => { lightAngle = Number(angleSel.value); loop.invalidate(); });
  }
  input.captureKeys(["KeyT"]);
  input.on((e) => {
    if (e.kind === "key" && e.phase === "down" && e.code === "KeyT" && !e.repeat) setTemporal(!temporal);
  });
  sync();

  // The readout, four times a second. fps counts frames actually rendered over
  // the last second ("idle" when the page has nothing to draw); GPU time is the
  // renderer's running average over its passes, so it holds its last value
  // while idle.
  const ticks: { t: number; n: number }[] = [];
  const last: { off: number | null; on: number | null } = { off: null, on: null };
  let fps = 0;
  const gpuMs = () => {
    const t = renderer.gpuTimings();
    return t ? Object.values(t).reduce((a, b) => a + b, 0) : null;
  };
  const ms = (v: number | null) => (v === null ? "–" : v.toFixed(v < 10 ? 2 : 1));
  const tick = () => {
    const now = performance.now();
    ticks.push({ t: now, n: frames });
    frames = 0;
    while (ticks.length > 1 && now - ticks[0].t > 1000) ticks.shift();
    const span = ticks.length > 1 ? (now - ticks[0].t) / 1000 : 0.25;
    const n = ticks.slice(1).reduce((a, k) => a + k.n, 0);
    fps = span > 0 ? n / span : 0;
    const g = gpuMs();
    // Remember a mode's time once the running average has settled on it (0.9 per frame).
    if (g !== null && sinceToggle >= BURST - 10 && ticks[ticks.length - 1].n > 0) last[temporal ? "on" : "off"] = g;
    if (!readout) return;
    const state = !temporal || !canAccumulate ? "history off" : renderer.converging() ? "converging…" : "converged";
    readout.textContent =
      `${n ? `${fps.toFixed(0)} fps` : "idle"} · ${g === null ? "GPU timing unavailable" : `GPU ${ms(g)} ms`}\n` +
      (g === null ? "" : `last off ${ms(last.off)} · on ${ms(last.on)} ms\n`) +
      `scale ${gpu.renderScale.toFixed(2)} · ${gpu.width}×${gpu.height} · ${state}`;
  };
  setInterval(tick, 250);

  if (params.has("e2e")) {
    Object.assign(window, {
      temporalStats: () => ({
        fps, gpuMs: gpuMs(), timings: renderer.gpuTimings(), temporal, converging: renderer.converging(),
        renderScale: gpu.renderScale, width: gpu.width, height: gpu.height, quality, lightAngle, rotate, always,
        lastOff: last.off, lastOn: last.on,
      }),
      temporalSet: (s: { temporal?: boolean; rotate?: boolean; always?: boolean; angle?: number }) => {
        if (s.temporal !== undefined) setTemporal(s.temporal);
        if (s.rotate !== undefined) rotate = s.rotate;
        if (s.always !== undefined) always = s.always;
        if (s.angle !== undefined) lightAngle = s.angle;
        sync();
        syncLoop();
        loop.invalidate();
      },
    });
  }

  const mem = renderer.stats();
  info.textContent = `${place.length} models, 2 lamps · built in ${((performance.now() - t0) / 1000).toFixed(1)} s · ${(mem.bytes / 1048576).toFixed(0)} MB · ${quality}${phone ? " (phone)" : ""} · T toggles · drag to turn, wheel to zoom`;
  syncLoop();
  loop.invalidate();
  screen.ready();
  markFrames(load, renderer);
  // The first toggle need not stall on its compile: the temporal kernels compile now, in the
  // background (prepare skips what is made already). A toggle before they are ready compiles
  // synchronously, as without it.
  if (canAccumulate && !temporal) void prepared(renderer.prepare({ temporal: true }));
  void reportLoadTimeline(load, { perf: false });
}
