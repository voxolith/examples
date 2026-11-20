// background — a sky written by the page, next to the renderer's default gradient.
//
// The renderer draws no sky of its own: whatever a ray sees when it leaves the
// world comes from a WESL module the host hands to `createRenderer`
// (`RendererOptions.background`), linked into the raymarch shader. SKY_WESL
// below is such a module: a horizon-to-zenith gradient (smooth or in flat
// bands), a sun disc with a glow, stars and a dark ground, all driven by 64
// floats the page packs each frame (`FrameParams.background`, read in the
// shader as `BG.params`) and by the frame time (`BG.time`). The same function
// colours primary rays and reflections, so the pond and the chrome ball show
// the sky too. Without a module the renderer links its own
// `GRADIENT_BACKGROUND_WESL`, two colours and nothing else; the Sky select
// swaps between the two. A background is chosen when the renderer is created,
// so the swap builds a new renderer from the same scene; everything else here
// is parameters, and changes with the next frame.
//
// The page renders on demand. "Animate" passes the frame time and draws every
// frame: the stars twinkle (BG.time) and the water ripples.
//
// URL options (declared below; the HUD's Options panel changes them, all of them at once):
//   ?sky=dusk|gradient   this page's module, or the renderer's default gradient
//   ?sun=10              the sun's height in degrees, 2 to 80 (low: a warm dusk with stars)
//   ?heading=195         the sun's compass heading in degrees
//   ?bands=6             draw the gradient in this many flat bands (0: smooth)
//   ?stars=0.8           star brightness, 0 to 1 (they fade as the sun climbs)
//   ?animate             pass the frame time: stars twinkle, water ripples
//   ?quality=, ?temporal=1, ?upscale=, ?reflections=0, ?renderScale=, ?debug=   the renderer's own

import { createRenderer, gradientBackgroundParams, makeCamera, observeResize, resizeToDisplay, BACKGROUND_FLOATS, type Renderer, type Vec3 } from "@voxolith/renderer";
import { PaletteAllocator, trackRenderer, type Role } from "@voxolith/engine";
import { createInput, makeOrbitController, prepareSurface } from "@voxolith/engine/input";
import { boot, runLoop } from "../shared/boot";
import { markFrames, prepared, reportLoadTimeline, step } from "../shared/loading";
import { STEPS } from "../shared/loading-screen";
import { defineOptions, RENDER_OPTIONS } from "../shared/options";
import { applyRenderOptions, type RenderControls } from "../shared/quality";

/**
 * The page's sky. It must export `background(rd, footprint)`: the linear colour along the unit
 * direction `rd`; `footprint` is the angle one pixel covers, used here to keep the sun's edge and
 * the stars from aliasing. It is called from a few places in the shader, so it stays small.
 */
const SKY_WESL = /* wgsl */ `
import package::bg::BG;

// BG.params, as skyParams() below packs them:
//   [0] xyz the sun's direction, w its angular radius (radians)
//   [1] rgb the horizon colour,  w bands (0 smooth, n: the gradient in n flat steps)
//   [2] rgb the zenith colour,   w star brightness
//   [3] rgb the sun's colour,    w twinkle (0 or 1)
//   [4] rgb the ground below the horizon

fn starHash(p : vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

fn background(rd : vec3<f32>, footprint : f32) -> vec3<f32> {
  let sun = BG.params[0];
  let bands = BG.params[1].w;
  var t = pow(clamp(rd.y, 0.0, 1.0), 0.6);
  if (bands > 0.5) { t = floor(t * bands + 0.5) / bands; }
  var col = mix(BG.params[1].xyz, BG.params[2].xyz, t);

  // Stars: at most one per cell of a longitude-latitude grid, never drawn smaller than a pixel
  // (and dimmer for it), so they neither flicker as the view turns nor swamp a reflection.
  let lat = asin(clamp(rd.y, -1.0, 1.0));
  let uv = vec2<f32>(atan2(rd.z, rd.x), lat) * 30.0;
  let cell = floor(uv);
  let h = starHash(cell);
  let at = cell + vec2<f32>(0.25 + 0.5 * starHash(cell + 7.0), 0.25 + 0.5 * starHash(cell + 13.0));
  let d = length((uv - at) * vec2<f32>(cos(lat), 1.0)) / 30.0;
  let r = max(0.0012, footprint);
  let pulse = mix(1.0, 0.6 + 0.4 * sin(BG.time * (2.0 + 5.0 * h) + h * 50.0), BG.params[3].w);
  let star = step(0.8, h) * (1.0 - smoothstep(0.5 * r, 1.5 * r, d)) * (0.0012 / r) * pulse;
  col += vec3<f32>(star * BG.params[2].w * smoothstep(0.08, 0.45, rd.y) * 3.0);

  // The sun: a disc with an edge one footprint wide, and a glow round it.
  let ang = acos(clamp(dot(rd, sun.xyz), -1.0, 1.0));
  let disc = 1.0 - smoothstep(sun.w - footprint, sun.w + footprint, ang);
  col += BG.params[3].xyz * (disc * 4.0 + 0.35 * exp(-ang * 5.0));

  return mix(col, BG.params[4].xyz, smoothstep(0.0, 0.12, -rd.y));
}
`;

const options = defineOptions({
  sky: { kind: "choice", label: "Sky", help: "This page's WESL module, or the renderer's default two-colour gradient. A background is linked into the shader, so the change builds a new renderer.", values: ["dusk", "gradient"], default: "dusk", live: true, format: (v: string) => (v === "dusk" ? "This page's WESL" : "The renderer's gradient") },
  sun: { kind: "number", label: "Sun height", help: "Degrees above the horizon. Low is a warm dusk with stars; the scene's light follows it.", min: 2, max: 80, step: 2, default: 10, live: true },
  heading: { kind: "number", label: "Sun heading", help: "The sun's compass heading in degrees.", min: 0, max: 360, step: 15, default: 195, live: true },
  bands: { kind: "number", label: "Bands", help: "Draw the gradient in this many flat bands; 0 is smooth.", min: 0, max: 12, step: 1, integer: true, default: 0, live: true },
  stars: { kind: "number", label: "Stars", help: "Star brightness; they fade as the sun climbs.", min: 0, max: 1, step: 0.1, default: 0.8, live: true },
  animate: { kind: "toggle", label: "Animate", help: "Pass the frame time and draw every frame: the stars twinkle and the water ripples.", default: false, live: true },
  ...RENDER_OPTIONS,
});

// The loading screen's rows, in this order.
const app = await boot("background", {
  blurb: "A sky written by the page",
  steps: [STEPS.device, { phase: "scene", label: "Building the scene" }, STEPS.shaders, STEPS.pipelines],
  options,
});
if (app) {
  const { gpu, canvas, info, load, screen } = app;

  // --- the scene: an island with a pond and a chrome ball, to reflect the sky -----------
  const size = { x: 128, y: 56, z: 128 };
  const C = size.x / 2;
  const palette = new PaletteAllocator(1);
  const roles: Role[] = [
    { id: "grass", name: "Grass", color: [0.3, 0.5, 0.24] },
    { id: "soil", name: "Soil", color: [0.36, 0.27, 0.19] },
    { id: "stone", name: "Stone", color: [0.55, 0.55, 0.57] },
    { id: "water", name: "Water", color: [0.1, 0.3, 0.42], material: { kind: "water", rough: 0.05, alpha: 0.35, att: 0.25 } },
    { id: "chrome", name: "Chrome", color: [0.92, 0.93, 0.95], material: { kind: "metal", rough: 0.04, metal: 1 } },
    { id: "gold", name: "Gold", color: [1.0, 0.76, 0.34], material: { kind: "metal", rough: 0.25, metal: 1 } },
  ];
  const { base } = palette.allocate(roles, "scene");
  const [GRASS, SOIL, STONE, WATER, CHROME, GOLD] = roles.map((_, i) => base + i);
  const data = await step(load, "scene", () => {
    const d = new Uint8Array(size.x * size.y * size.z);
    const set = (x: number, y: number, z: number, v: number) => { d[x + y * size.x + z * size.x * size.y] = v; };
    for (let z = 0; z < size.z; z++)
      for (let x = 0; x < size.x; x++) {
        const r = Math.hypot(x - C, z - C);
        if (r > 60) continue;
        // Low hills falling to the island's edge, a ring-shaped pond, a plinth in the middle.
        const pond = r > 14 && r < 36;
        const h = pond ? 5 : r <= 14 ? 13 : Math.round(9 + 2 * Math.sin(x / 8) * Math.cos(z / 9) - Math.max(0, r - 50) * 0.7);
        for (let y = 0; y <= h; y++) set(x, y, z, r <= 14 ? STONE : y === h && !pond ? GRASS : SOIL);
        if (pond) for (let y = 6; y <= 9; y++) set(x, y, z, WATER);
      }
    // The chrome ball on the plinth.
    for (let z = -11; z <= 11; z++) for (let y = -11; y <= 11; y++) for (let x = -11; x <= 11; x++)
      if (x * x + y * y + z * z <= 121) set(C + x, 26 + y, C + z, CHROME);
    // Eight stone pillars with gold caps, on a ring outside the pond.
    for (let i = 0; i < 8; i++) {
      const px = Math.round(C + Math.cos((i / 8) * Math.PI * 2) * 46), pz = Math.round(C + Math.sin((i / 8) * Math.PI * 2) * 46);
      const top = 22 + (i % 3) * 7;
      for (let y = 8; y <= top; y++) for (let z = -1; z <= 1; z++) for (let x = -1; x <= 1; x++) set(px + x, y, pz + z, y > top - 2 ? GOLD : STONE);
    }
    return d;
  });
  const scene = { size, data, palette: palette.buildPalette(), materials: palette.buildMaterials() };

  // --- the sky's parameters, and the light that goes with them ------------------------------
  const mix = (a: Vec3, b: Vec3, k: number): Vec3 => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  const GROUND: Vec3 = [0.1, 0.09, 0.1];
  const params = new Float32Array(BACKGROUND_FLOATS);
  /** Everything a frame needs besides the camera: the packed sky and the matching key light and sky light. */
  const skyFrame = (custom: boolean) => {
    const el = (options.get("sun") * Math.PI) / 180, az = (options.get("heading") * Math.PI) / 180;
    const sunDir: Vec3 = [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
    // 0 at the horizon (dusk colours) to 1 from 35° up (day colours).
    const day = Math.min(1, options.get("sun") / 35);
    const horizon = mix([0.95, 0.42, 0.22], [0.75, 0.82, 0.92], day);
    const zenith = mix([0.07, 0.08, 0.24], [0.25, 0.45, 0.85], day);
    const sunColor = mix([1, 0.5, 0.22], [1, 0.96, 0.85], day);
    if (custom) {
      params.set([...sunDir, 0.035, ...horizon, options.get("bands"), ...zenith, options.get("stars") * (1 - day), ...sunColor, options.get("animate") ? 1 : 0, ...GROUND, 0]);
    } else gradientBackgroundParams(horizon, zenith, params);
    return {
      lightDir: sunDir,
      lightColor: sunColor.map((c) => c * (0.7 + 0.5 * day)) as Vec3,
      ambientSky: mix(zenith, horizon, 0.4).map((c) => c * 0.7) as Vec3,
      ambientGround: mix(GROUND, horizon, 0.25),
      background: params,
    };
  };

  // --- the renderer: one per background ---------------------------------------------------
  // The background module is linked into the shader when the renderer is created, so changing
  // it means a new renderer (the scene is small: it takes a moment).
  let first = true;
  const build = async (sky: "dusk" | "gradient"): Promise<{ renderer: Renderer; render: RenderControls }> => {
    const renderer = await createRenderer(gpu, scene, {
      onLoad: first ? trackRenderer(load) : undefined,
      deferPipelines: true,
      // Leaving `background` out links GRADIENT_BACKGROUND_WESL.
      background: sky === "dusk" ? { source: SKY_WESL } : undefined,
    });
    first = false;
    // A CPU adapter (SwiftShader) starts on the Low preset: no shadows or ambient occlusion.
    const render = applyRenderOptions(options, renderer, { preset: gpu.software ? "low" : "medium", changed: () => loop.invalidate() });
    await prepared(renderer.prepare());
    return { renderer, render };
  };
  let sky = options.get("sky");
  let view = await build(sky);
  // A CPU adapter takes a while over a full-size frame, so it draws small.
  const scale = gpu.software ? Math.min(gpu.renderScale, 0.3) : gpu.renderScale;

  // --- camera and loop --------------------------------------------------------------------
  const camera = makeCamera({ target: [C, 18, C], distance: 230, pitchDeg: 8, fovDeg: 45 });
  prepareSurface(canvas, { contextMenu: false });
  const input = createInput(canvas, { loop: { invalidate: () => loop.invalidate() } });
  const orbit = makeOrbitController(input, { yaw: 20, pitch: 8, distance: 230, distanceLimits: [60, 500], pitchLimits: [2, 85], target: [C, 18, C], fovDeg: 45 });
  const loop = runLoop((now) => {
    gpu.renderScale = view.render.fixedScale() || scale;
    resizeToDisplay(gpu);
    view.renderer.render({
      ...camera(orbit.yaw(), orbit.distance(), orbit.target(), orbit.pitch()),
      ...skyFrame(sky === "dusk"),
      // Without `time` nothing moves: BG.time and the water's ripples both come from it.
      ...(options.get("animate") ? { time: now / 1000 } : {}),
    });
  }, options.get("animate"), () => view.renderer.converging());
  observeResize(canvas, loop);

  // --- HUD ----------------------------------------------------------------------------------
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
  const skySel = $<HTMLSelectElement>("sky"), sunSel = $<HTMLSelectElement>("sun");
  const bandsBtn = $<HTMLButtonElement>("bands-toggle"), animateBtn = $<HTMLButtonElement>("animate-toggle");
  const sync = () => {
    if (skySel) skySel.value = sky;
    if (sunSel) {
      const sun = options.get("sun");
      if (![...sunSel.options].some((o) => Number(o.value) === sun)) sunSel.append(new Option(`Sun ${sun}°`, String(sun)));
      sunSel.value = String(sun);
    }
    const bands = options.get("bands"), animate = options.get("animate");
    if (bandsBtn) { bandsBtn.textContent = `Bands: ${bands || "off"}`; bandsBtn.setAttribute("aria-pressed", String(bands > 0)); bandsBtn.disabled = sky !== "dusk"; }
    if (animateBtn) { animateBtn.textContent = `Animate: ${animate ? "on" : "off"}`; animateBtn.setAttribute("aria-pressed", String(animate)); }
    info.textContent = sky === "dusk"
      ? `this page's WESL sky: sun ${options.get("sun")}°, ${bands ? `${bands} bands` : "smooth"}, stars, a ground · drag to turn, wheel to zoom`
      : "the renderer's default: two colours, horizon to zenith · drag to turn, wheel to zoom";
    loop.setContinuous(animate);
    loop.invalidate();
  };
  let building = false;
  const setSky = async (next: "dusk" | "gradient") => {
    if (next === sky || building) return sync();
    building = true;
    const old = view.renderer;
    view = await build(next);
    old.destroy();
    sky = next;
    building = false;
    options.sync("sky", sky);
    sync();
  };
  // The HUD's controls and the Options panel change the same options: each tells the other.
  for (const deg of [4, 10, 20, 40, 70]) sunSel?.append(new Option(`Sun ${deg}°`, String(deg)));
  skySel?.addEventListener("change", () => void setSky(skySel.value as "dusk" | "gradient"));
  sunSel?.addEventListener("change", () => { options.sync("sun", Number(sunSel.value)); sync(); });
  bandsBtn?.addEventListener("click", () => { options.sync("bands", options.get("bands") ? 0 : 6); sync(); });
  animateBtn?.addEventListener("click", () => { options.sync("animate", !options.get("animate")); sync(); });
  options.on("sky", (v) => void setSky(v));
  for (const key of ["sun", "heading", "bands", "stars", "animate"] as const) options.on(key, sync);

  sync();
  screen.ready();
  markFrames(load, view.renderer);
  void reportLoadTimeline(load, { perf: false });
}
