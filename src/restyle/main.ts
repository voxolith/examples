// restyle — one set of models, recoloured by palette; models added and removed at run time.
//
// A voxel of a generated model is a role (bark, leaf, twig), never a colour.
// The colour comes from a palette: 256 slots for what is stamped into the
// world, and any number of palettes of their own for instances
// (`renderer.addPalette`). So a look is a few hundred bytes: the Look select
// rewrites each species' palette (`renderer.setPaletteColors`) and the
// ground's slots in the world palette (`renderer.updatePalette`), and every
// tree changes with the next frame. No model is regenerated or uploaded again;
// the readout says how long the restyle took.
//
// The seasons are the tree generator's own colours for the same roles
// (`skinFor(species, season)`); "frost" and "burnt" are tints computed here
// from each role's id, the way a game would show damage or a faction. A real
// winter tree is a different model (bare boughs, snow on them): that is the
// generator's `look.season`, and needs a new model. This page only recolours.
//
// Each tree is a model of its own, drawn as one instance. "Add tree"
// generates one and uploads it (`renderer.addModel`); "Remove tree" places the
// instances without it and then frees its bricks (`renderer.removeModel`).
// Freed bricks go back to the renderer's pool and the next model takes them,
// so adding and removing in turn never grows the GPU buffers (the readout's
// megabytes stay put).
//
// URL options (declared below; the HUD's Options panel changes them: the look and the tree count
// at once, the seed by reloading):
//   ?look=summer         spring | summer | autumn | frost | burnt
//   ?trees=7             how many trees stand at the start, 0 to 24
//   ?seed=               the scene's seed
//   ?quality=, ?temporal=1, ?upscale=, ?reflections=0, ?renderScale=, ?debug=   the renderer's own
//   ?e2e                 window.restyleStats() for the test tools

import { createRenderer, makeCamera, observeResize, resizeToDisplay, type Instance } from "@voxolith/renderer";
import { hashSeed, seededRandom } from "@voxolith/renderer/core";
import { instancePalette, PaletteAllocator, trackRenderer, type EntityModel, type RGB, type Role } from "@voxolith/engine";
import { createInput, makeOrbitController, prepareSurface } from "@voxolith/engine/input";
import { classicSky } from "@voxolith/engine/atmosphere";
import { buildRoles, generateTree, PRESETS as TREES, skinFor } from "@voxolith/gen-tree";
import { boot, runLoop } from "../shared/boot";
import { markFrames, nextFrame, prepared, reportLoadTimeline, step } from "../shared/loading";
import { STEPS } from "../shared/loading-screen";
import { defineOptions, OPTION, RENDER_OPTIONS, seedOption } from "../shared/options";
import { applyRenderOptions } from "../shared/quality";
import { DAYLIGHT } from "../shared/env";

const LOOKS = ["spring", "summer", "autumn", "frost", "burnt"] as const;
type Look = (typeof LOOKS)[number];
const MAX_TREES = 24;
const options = defineOptions({
  look: { kind: "choice", label: "Look", help: "The palettes' colours. Changing it rewrites a few palettes; no model is regenerated.", values: LOOKS, default: "summer", live: true, format: (v: string) => v[0].toUpperCase() + v.slice(1) },
  trees: { kind: "number", label: "Trees", help: "How many trees stand; each is a model of its own, added and removed as this changes.", min: 0, max: MAX_TREES, step: 1, integer: true, default: 7, live: true },
  seed: seedOption("restyle"),
  ...RENDER_OPTIONS,
  e2e: OPTION.e2e,
});
const seed = hashSeed(options.get("seed"));

// --- looks: colours per role, for the trees and for the ground ---------------------------------
const SPECIES = ["oak", "maple", "birch", "spruce"] as const;
const mix = (a: RGB, b: RGB, k: number): RGB => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
/** A species' roles in a look. The roles and their order never change, only their colours. */
function treeRoles(species: string, look: Look): Role[] {
  if (look === "frost") {
    // The winter colours with rime on the leaves and a dusting on the bark.
    return buildRoles(skinFor(species, "winter")).map((r) => ({ ...r, color: mix(r.color, [0.93, 0.96, 1], r.id.startsWith("leaf") ? 0.7 : 0.2) }));
  }
  if (look === "burnt") {
    // Charred wood, and what leaves are left the colour of embers and ash.
    return buildRoles(skinFor(species, "summer")).map((r) => {
      const lum = 0.3 * r.color[0] + 0.6 * r.color[1] + 0.1 * r.color[2];
      return { ...r, color: r.id.startsWith("leaf") ? mix([0.2, 0.07, 0.03], [0.55, 0.22, 0.06], lum) : ([0.05 + lum * 0.1, 0.045 + lum * 0.09, 0.04 + lum * 0.08] as RGB) };
    });
  }
  return buildRoles(skinFor(species, look));
}
const GROUND: Record<Look, [RGB, RGB, RGB]> = {
  spring: [[0.4, 0.62, 0.28], [0.46, 0.66, 0.3], [0.4, 0.29, 0.2]],
  summer: [[0.3, 0.5, 0.22], [0.34, 0.54, 0.24], [0.4, 0.29, 0.2]],
  autumn: [[0.5, 0.44, 0.2], [0.58, 0.4, 0.17], [0.38, 0.27, 0.18]],
  frost: [[0.85, 0.89, 0.94], [0.76, 0.82, 0.88], [0.4, 0.33, 0.28]],
  burnt: [[0.13, 0.12, 0.11], [0.2, 0.17, 0.14], [0.18, 0.13, 0.1]],
};

// The loading screen's rows, in this order.
const app = await boot("restyle", {
  blurb: "One set of models, restyled by palette",
  steps: [STEPS.device, STEPS.shaders, STEPS.pipelines, { phase: "scene", label: "Building the scene" }, STEPS.models],
  options,
});
if (app) {
  const { gpu, canvas, info, load, screen } = app;
  let look: Look = options.get("look");

  // --- the world: a round lawn, stamped; its three slots are restyled with the trees ----------
  const SIZE = { x: 384, y: 176, z: 384 };
  const C = SIZE.x / 2, TOP = 5;
  const palette = new PaletteAllocator(1);
  const { base: lawn } = palette.allocate(GROUND[look].map((color, i) => ({ id: `ground${i}`, name: "Ground", color })), "ground");
  const renderer = await createRenderer(gpu, { size: SIZE, palette: palette.buildPalette() }, { onLoad: trackRenderer(load), deferPipelines: true, background: classicSky });
  renderer.setClipBounds([0, 0, 0], [SIZE.x - 1, SIZE.y - 1, SIZE.z - 1]);
  // A CPU adapter (SwiftShader) starts on the Low preset, and draws small.
  const render = applyRenderOptions(options, renderer, { preset: gpu.software ? "low" : "medium", changed: () => loop.invalidate() });
  const scale = gpu.software ? Math.min(gpu.renderScale, 0.3) : gpu.renderScale;
  // The trees are instances, and none is placed yet: say so, so the right pipelines compile.
  await prepared(renderer.prepare({ instances: true }));
  await step(load, "scene", () => {
    renderer.edit({ x0: 0, y0: 0, z0: 0, x1: SIZE.x - 1, y1: TOP, z1: SIZE.z - 1 }, (cells, ox, oy, oz) => {
      let any = false;
      for (let i = 0; i < 512; i++) {
        const x = ox + (i & 7), y = oy + ((i >> 3) & 7), z = oz + (i >> 6);
        if (y > TOP || Math.hypot(x - C, z - C) > C - 6) continue;
        // Two tones of turf in patches, soil below.
        cells[i] = lawn + (y < TOP ? 2 : Math.sin(x / 9) * Math.cos(z / 7) + Math.sin((x + z) / 13) > 0.5 ? 1 : 0);
        any = true;
      }
      return any;
    });
  });

  // --- palettes: one per species, shared by every tree of it ---------------------------------
  const paletteOf = new Map<string, number>();
  for (const species of SPECIES) {
    const { colors, materials } = instancePalette(treeRoles(species, look));
    paletteOf.set(species, renderer.addPalette(colors, materials));
  }
  let restyleMs = 0;
  const restyle = (next: Look) => {
    const t0 = performance.now();
    look = next;
    // Instances: rewrite each species' palette in place.
    for (const species of SPECIES) {
      const { colors, materials } = instancePalette(treeRoles(species, look));
      renderer.setPaletteColors(paletteOf.get(species)!, colors, materials);
    }
    // The world's 256 slots: change the ground's three and upload the palette again.
    GROUND[look].forEach((color, i) => palette.setColor(lawn + i, color));
    renderer.updatePalette(palette.buildPalette());
    restyleMs = performance.now() - t0;
    loop.invalidate();
  };

  // --- trees: a model each, added and removed --------------------------------------------------
  interface Tree { model: number; species: string; x: number; z: number; yaw: number; anchor: EntityModel["anchor"]; }
  const trees: Tree[] = [];
  let made = 0;
  const place = () => {
    const list: Instance[] = trees.map((t) => ({ model: t.model, x: t.x, y: TOP + 1, z: t.z, yaw: t.yaw, anchor: t.anchor, base: paletteOf.get(t.species)! }));
    renderer.setInstances(list);
    loop.invalidate();
  };
  const addTree = () => {
    if (trees.length >= MAX_TREES) return;
    // The n-th tree is always the same one: its species, shape and spot follow from the seed.
    const n = trees.length, rng = seededRandom(seed + n * 7919);
    const species = SPECIES[n % SPECIES.length];
    const p = structuredClone(TREES[species]);
    // Two thirds of the presets' 19 m, so a tree takes about 50 ms to grow.
    p.shape.height = 112 + Math.round(rng() * 28);
    const { model } = generateTree(p, rng).entity;
    made++;
    // A sunflower spiral outwards from the middle, so any number of trees spreads evenly.
    const a = n * 2.39996, r = 24 + 31 * Math.sqrt(n);
    trees.push({ model: renderer.addModel(model), species, x: C + Math.cos(a) * r, z: C + Math.sin(a) * r, yaw: rng() * Math.PI * 2, anchor: model.anchor });
    place();
  };
  const removeTree = () => {
    const t = trees.pop();
    if (!t) return;
    // First place the instances without it (an instance may not name a removed model), then free it.
    place();
    renderer.removeModel(t.model);
  };

  // --- camera and loop: render on demand -------------------------------------------------------
  const target: [number, number, number] = [C, 56, C];
  const camera = makeCamera({ target, distance: 560, pitchDeg: 26, fovDeg: 42 });
  prepareSurface(canvas, { contextMenu: false });
  const input = createInput(canvas, { loop: { invalidate: () => loop.invalidate() } });
  const orbit = makeOrbitController(input, { yaw: 30, pitch: 26, distance: 560, distanceLimits: [80, 1100], pitchLimits: [4, 85], fovDeg: 42, target });
  const loop = runLoop(() => {
    gpu.renderScale = render.fixedScale() || scale;
    resizeToDisplay(gpu);
    renderer.render({ ...camera(orbit.yaw(), orbit.distance(), orbit.target(), orbit.pitch()), ...DAYLIGHT });
  }, false, () => renderer.converging());
  observeResize(canvas, loop);

  // The first trees, counted on the loading screen.
  const models = load.task("models", options.get("trees"));
  for (let i = 0; i < options.get("trees"); i++) {
    await nextFrame();
    addTree();
    models.tick();
  }
  models.end();

  // --- HUD -----------------------------------------------------------------------------------
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
  const lookSel = $<HTMLSelectElement>("look"), addBtn = $<HTMLButtonElement>("add"), removeBtn = $<HTMLButtonElement>("remove");
  const sync = () => {
    if (lookSel) lookSel.value = look;
    if (addBtn) addBtn.disabled = trees.length >= MAX_TREES;
    if (removeBtn) removeBtn.disabled = trees.length === 0;
    const st = renderer.instanceStats();
    info.textContent = `${look} · ${trees.length} trees, ${st.models} models in ${(st.bytes / 1048576).toFixed(1)} MB on the GPU, ${made} generated so far · ` +
      `last restyle ${restyleMs.toFixed(2)} ms: ${SPECIES.length} palettes and 3 world slots, no model touched`;
  };
  const setTrees = (n: number) => {
    while (trees.length < n) addTree();
    while (trees.length > n) removeTree();
    options.sync("trees", trees.length);
    sync();
  };
  for (const l of LOOKS) lookSel?.append(new Option(`Look: ${l}`, l));
  lookSel?.addEventListener("change", () => { restyle(lookSel.value as Look); options.sync("look", look); sync(); });
  addBtn?.addEventListener("click", () => setTrees(trees.length + 1));
  removeBtn?.addEventListener("click", () => setTrees(trees.length - 1));
  options.on("look", (l) => { restyle(l); sync(); });
  options.on("trees", setTrees);

  if (options.get("e2e")) Object.assign(window, { restyleStats: () => ({ look, trees: trees.length, made, restyleMs, ...renderer.instanceStats(), pool: renderer.stats() }) });

  sync();
  loop.invalidate();
  screen.ready();
  markFrames(load, renderer);
  void reportLoadTimeline(load, { perf: false });
}
