// select — pick a voxel, highlight what it belongs to, and carve the world.
//
// A small garden stamped into the world grid: a cottage, trees, bushes and
// rocks from the generators, on layered ground. Each object gets a palette
// range of its own (`PaletteAllocator`), which is what makes it selectable:
// `renderer.setHighlight({ mode: 1, slotMin, slotMax })` keeps the voxels in
// that slot range in colour, rims their outline and greys the rest.
//
// Picking is done on the CPU: `makeRay` turns a pointer position into the ray
// the shader casts through that pixel, and `voxelRaycast` walks it through the
// page's own dense copy of the grid. The value of the voxel it hits says which
// object it is. With the mouse, hovering highlights and a click keeps the
// selection; a tap does both on a touch screen.
//
// Carving is `renderer.clear(box)`: it frees every brick wholly inside the box
// and empties the cells of the ones it only partly covers. The dig tool clears
// a cube where you tap, and Remove clears the selected object's bounding box.
// The page empties the same box in its own copy, so picking sees the hole.
//
// URL options (declared below; the HUD's Options panel changes them: the tool and the dig size at
// once, the seed by reloading):
//   ?tool=select|dig     what a click or tap does (T switches)
//   ?dig=12              the edge of the cube the dig tool clears, in voxels (2 to 32)
//   ?seed=               the scene's seed
//   ?quality=, ?temporal=1, ?upscale=, ?reflections=0, ?renderScale=, ?debug=   the renderer's own
//   ?perf, ?full                                 the frame rate (and a phone's traced fraction); a phone gets the phone
//                                                profile (../shared/quality.ts), ?full the desktop settings
//   ?e2e                 window.selectStats() and window.selectAt(x, y) for the test tools

import { createRenderer, makeCamera, makeRay, observeResize, resizeToDisplay, voxelRaycast, type DirtyBox } from "@voxolith/renderer";
import { hashSeed, seededRandom } from "@voxolith/renderer/core";
import { blitModel, PaletteAllocator, trackRenderer, type Entity, type Role } from "@voxolith/engine";
import { createInput, makeOrbitController, prepareSurface, recogniseGestures } from "@voxolith/engine/input";
import { classicSky } from "@voxolith/engine/atmosphere";
import { generateTree, PRESETS as TREES } from "@voxolith/gen-tree";
import { generateRock, PRESETS as ROCKS } from "@voxolith/gen-rock";
import { generateBush, PRESETS as BUSHES } from "@voxolith/gen-bush";
import { generateBuilding, PRESETS as BUILDINGS } from "@voxolith/gen-building";
import { boot, runLoop } from "../shared/boot";
import { markFrames, nextFrame, prepared, reportLoadTimeline, step } from "../shared/loading";
import { STEPS } from "../shared/loading-screen";
import { defineOptions, OPTION, RENDER_OPTIONS, seedOption } from "../shared/options";
import { phoneProfile } from "../shared/scale";
import { applyRenderOptions } from "../shared/quality";
import { DAYLIGHT } from "../shared/env";

const options = defineOptions({
  tool: { kind: "choice", label: "Tool", help: "What a click or tap does: select the object under it, or dig a cube out of the world (T).", values: ["select", "dig"], default: "select", live: true, format: (v: string) => (v === "dig" ? "Dig" : "Select") },
  dig: { kind: "number", label: "Dig size", help: "The edge of the cube the dig tool clears, in voxels.", min: 2, max: 32, step: 2, integer: true, default: 12, live: true },
  seed: seedOption("select"),
  ...RENDER_OPTIONS,
  e2e: OPTION.e2e,
});
const seed = hashSeed(options.get("seed"));

// The loading screen's rows, in this order.
const app = await boot("select", {
  blurb: "Pick, highlight and carve",
  steps: [STEPS.device, STEPS.models, { phase: "scene", label: "Building the scene" }, STEPS.shaders, STEPS.pipelines],
  options,
});
if (app) {
  const { gpu, canvas, info, load, screen } = app;
  // A phone (../shared/scale.ts) gets the phone profile: the renderer's through applyRenderOptions below.
  const phone = phoneProfile(gpu, options);

  // --- models: nine objects, generated on this thread --------------------------------------
  // Half-size trees: the presets stand 19 m tall, more than this garden needs.
  const tree = (kind: string, height: number, n: number): Entity => {
    const p = structuredClone(TREES[kind]);
    p.shape.height = height;
    return generateTree(p, seededRandom(seed + n)).entity;
  };
  const makers: { name: string; x: number; z: number; make: () => Entity }[] = [
    { name: "cottage", x: 112, z: 104, make: () => generateBuilding(BUILDINGS.cottage, seededRandom(seed + 1)).entity },
    { name: "oak", x: 44, z: 60, make: () => tree("oak", 104, 2) },
    { name: "maple", x: 182, z: 58, make: () => tree("maple", 104, 3) },
    { name: "spruce", x: 176, z: 170, make: () => tree("spruce", 100, 4) },
    { name: "boulder", x: 62, z: 150, make: () => generateRock(ROCKS.boulder, seededRandom(seed + 5)).entity },
    { name: "sandstone", x: 120, z: 184, make: () => generateRock(ROCKS.sandstone, seededRandom(seed + 6)).entity },
    { name: "mossy rock", x: 196, z: 112, make: () => generateRock(ROCKS.mossy, seededRandom(seed + 7)).entity },
    { name: "bush", x: 36, z: 112, make: () => generateBush(BUSHES.bush, seededRandom(seed + 8)).entity },
    { name: "flowering bush", x: 92, z: 36, make: () => generateBush(BUSHES.flowering, seededRandom(seed + 9)).entity },
  ];
  const models = load.task("models", makers.length);
  await nextFrame();
  const entities = makers.map((m) => { const e = m.make(); models.tick(); return e; });
  models.end();

  // --- the world: a dense grid the page keeps, since picking reads it ------------------------
  const SIZE = { x: 224, y: 144, z: 224 };
  /** The ground's top layer. */
  const GROUND = 26;
  const world = { size: SIZE, data: new Uint8Array(SIZE.x * SIZE.y * SIZE.z) };
  const at = (x: number, y: number, z: number) => x + y * SIZE.x + z * SIZE.x * SIZE.y;
  const palette = new PaletteAllocator(1);
  const strata: Role[] = [
    { id: "grass", name: "Grass", color: [0.33, 0.52, 0.25] },
    { id: "soil", name: "Soil", color: [0.4, 0.29, 0.2] },
    { id: "clay", name: "Clay", color: [0.6, 0.42, 0.3] },
    { id: "stone", name: "Stone", color: [0.5, 0.5, 0.52] },
  ];
  const { base: ground } = palette.allocate(strata, "ground");
  /** What can be selected: a name, the palette range that marks its voxels, and the box it was stamped into. */
  interface Selectable { name: string; slotMin: number; slotMax: number; box: DirtyBox; }
  const objects: Selectable[] = [];
  await step(load, "scene", () => {
    const rng = seededRandom(seed);
    for (let z = 0; z < SIZE.z; z++)
      for (let x = 0; x < SIZE.x; x++) {
        // Strata that wander a little, so a hole shows them.
        const wave = Math.round(2 * Math.sin(x / 17 + seed % 7) + 2 * Math.cos(z / 23));
        for (let y = 0; y <= GROUND; y++) world.data[at(x, y, z)] = ground + (y === GROUND ? 0 : y > GROUND - 7 + wave ? 1 : y > 9 + wave ? 2 : 3);
      }
    makers.forEach((m, i) => {
      const model = entities[i].model;
      // A range of its own per object, even for two of a kind: the range is the selection.
      const { base } = palette.allocate(model.roles, `object${i}`);
      // The model's lowest layer on the grass (a rock's anchor sits a little inside it).
      const box = blitModel(world, model, { x: m.x, y: GROUND + 1 + model.anchor[1], z: m.z }, base, i === 0 ? 0 : (Math.floor(rng() * 4) as 0 | 1 | 2 | 3));
      if (box) objects.push({ name: m.name, slotMin: base, slotMax: base + model.roles.length - 1, box });
    });
  });
  /** The scene as built, for Reset. */
  const pristine = world.data.slice(), built = [...objects];

  const renderer = await createRenderer(gpu, { ...world, palette: palette.buildPalette(), materials: palette.buildMaterials() }, { onLoad: trackRenderer(load), deferPipelines: true, background: classicSky });
  // A CPU adapter (SwiftShader) starts on the Low preset, and draws small.
  const render = applyRenderOptions(options, renderer, { gpu, phone, preset: gpu.software ? "low" : "medium", changed: () => loop.invalidate() });
  const scale = gpu.software ? Math.min(gpu.renderScale, 0.3) : gpu.renderScale;
  await prepared(renderer.prepare());

  // --- camera and loop: nothing animates, so render on demand --------------------------------
  const target: [number, number, number] = [SIZE.x / 2, GROUND + 26, SIZE.z / 2];
  const camera = makeCamera({ target, distance: 370, pitchDeg: 34, fovDeg: 42 });
  prepareSurface(canvas, { contextMenu: false });
  const input = createInput(canvas, { loop: { invalidate: () => loop.invalidate() } });
  const orbit = makeOrbitController(input, {
    yaw: 28, pitch: 34, distance: 370, distanceLimits: [60, 700], pitchLimits: [6, 85], fovDeg: 42,
    target, pan: "secondary", panBounds: { minX: 0, maxX: SIZE.x, minZ: 0, maxZ: SIZE.z },
  });
  const frame = () => camera(orbit.yaw(), orbit.distance(), orbit.target(), orbit.pitch());
  const loop = runLoop((now) => {
    gpu.renderScale = render.pace(now, scale);
    resizeToDisplay(gpu);
    renderer.render({ ...frame(), ...DAYLIGHT });
  }, false, () => renderer.converging());
  observeResize(canvas, loop);

  // --- picking -------------------------------------------------------------------------------
  /** The voxel under a client position, and the object it belongs to (null for the ground). */
  const pick = (clientX: number, clientY: number) => {
    const { origin, dir } = makeRay(canvas, frame(), clientX, clientY);
    const hit = voxelRaycast(SIZE, world.data, origin, dir, 4096);
    if (!hit) return null;
    const slot = world.data[at(hit.cell[0], hit.cell[1], hit.cell[2])];
    return { cell: hit.cell, object: objects.find((o) => slot >= o.slotMin && slot <= o.slotMax) ?? null };
  };

  // --- highlight -----------------------------------------------------------------------------
  let tool = options.get("tool");
  /** Kept by a click or tap; the mouse's hover shows over it while it lasts. */
  let selected: Selectable | null = null;
  let hovered: Selectable | null = null;
  let shown: Selectable | null = null;
  let carved = 0;
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
  const toolBtn = $<HTMLButtonElement>("tool-toggle"), removeBtn = $<HTMLButtonElement>("remove"), resetBtn = $<HTMLButtonElement>("reset");
  const sync = () => {
    const next = tool === "select" ? (hovered ?? selected) : null;
    if (next !== shown) {
      shown = next;
      // mode 1: slots slotMin..slotMax keep their colour and get a rim, everything else is greyed.
      renderer.setHighlight(shown ? { mode: 1, slotMin: shown.slotMin, slotMax: shown.slotMax } : { mode: 0, slotMin: 0, slotMax: 0 });
      loop.invalidate();
    }
    if (toolBtn) toolBtn.textContent = `Tool: ${tool}`;
    if (removeBtn) removeBtn.disabled = !selected;
    info.textContent = tool === "dig"
      ? `dig: tap to clear a ${options.get("dig")}-voxel cube · ${carved} cleared · T for select · drag to turn`
      : shown
        ? `${shown.name}: palette slots ${shown.slotMin} to ${shown.slotMax}${shown === selected ? " · selected (X removes it)" : ""}`
        : `${objects.length} objects, each with a palette range of its own · hover or tap one · T for the dig tool`;
  };

  // --- carving -------------------------------------------------------------------------------
  /** Clear a box on the GPU and in the page's copy, so the picture and the picking agree. */
  const carve = (b: DirtyBox) => {
    const box = { x0: Math.max(0, b.x0), y0: Math.max(1, b.y0), z0: Math.max(0, b.z0), x1: Math.min(SIZE.x - 1, b.x1), y1: Math.min(SIZE.y - 1, b.y1), z1: Math.min(SIZE.z - 1, b.z1) };
    if (box.x0 > box.x1 || box.y0 > box.y1 || box.z0 > box.z1) return;
    renderer.clear(box);
    for (let z = box.z0; z <= box.z1; z++) for (let y = box.y0; y <= box.y1; y++) world.data.fill(0, at(box.x0, y, z), at(box.x1, y, z) + 1);
    carved++;
    loop.invalidate();
  };
  const remove = () => {
    if (!selected) return;
    carve(selected.box);
    objects.splice(objects.indexOf(selected), 1);
    selected = hovered = null;
    sync();
  };
  const tap = (x: number, y: number) => {
    const p = pick(x, y);
    if (tool === "select") selected = p?.object ?? null;
    else if (p) {
      const n = options.get("dig"), lo = Math.floor(n / 2);
      carve({ x0: p.cell[0] - lo, y0: p.cell[1] - lo, z0: p.cell[2] - lo, x1: p.cell[0] - lo + n - 1, y1: p.cell[1] - lo + n - 1, z1: p.cell[2] - lo + n - 1 });
    }
    sync();
  };
  const setTool = (t: "select" | "dig") => { tool = t; hovered = null; options.sync("tool", t); sync(); };
  const reset = () => {
    world.data.set(pristine);
    // The whole grid again, from the page's copy.
    renderer.updateVoxels(world.data);
    objects.splice(0, objects.length, ...built);
    selected = hovered = null;
    carved = 0;
    loop.invalidate();
    sync();
  };

  // A tap is a press released without dragging (the orbit controller takes the drags).
  recogniseGestures(input, { tap: (t) => { if (t.button === 0) tap(t.x, t.y); } }, { longPressMs: 0 });
  // The input layer reports pressed pointers only; a mouse's hover is the canvas's own event.
  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse" || e.buttons !== 0 || tool !== "select") return;
    const over = pick(e.clientX, e.clientY)?.object ?? null;
    if (over !== hovered) { hovered = over; sync(); }
  });
  canvas.addEventListener("pointerleave", () => { if (hovered) { hovered = null; sync(); } });
  input.captureKeys(["KeyT", "KeyX"]);
  input.on((e) => {
    if (e.kind !== "key" || e.phase !== "down" || e.repeat) return;
    if (e.code === "KeyT") setTool(tool === "select" ? "dig" : "select");
    if (e.code === "KeyX") remove();
  });
  toolBtn?.addEventListener("click", () => setTool(tool === "select" ? "dig" : "select"));
  removeBtn?.addEventListener("click", remove);
  resetBtn?.addEventListener("click", reset);
  options.on("tool", setTool);
  options.on("dig", sync);

  if (options.get("e2e")) Object.assign(window, {
    selectStats: () => ({ objects: objects.length, selected: selected?.name ?? null, shown: shown?.name ?? null, carved, bricks: renderer.stats().bricks }),
    selectAt: (x: number, y: number) => pick(x, y)?.object?.name ?? null,
  });

  sync();
  loop.invalidate();
  screen.ready();
  markFrames(load, renderer);
  void reportLoadTimeline(load, { perf: false });
}
