// valley — the world page's valley at 20, 50 or 100 voxels per metre, down to a rat's-eye scale.
//
// The same valley as ../world: its terrain, river, village, footpaths and
// forest come from the same layout (../world/layout.ts), decided in the
// world page's 10 voxels per metre and multiplied by two, five or ten here.
// What changes is the resolution:
//   - every model is generated at 20 (5 cm voxels, a phone's default), 50
//     (2 cm, the desktop default) or 100 voxels per metre (1 cm): the
//     generators refine their own design (single leaves and needles, bark
//     furrows, bricks, tiles and mortar at real size, rounded rock), as
//     sparse models;
//   - models are drawn as instances, once each on the GPU however often they
//     stand in the valley, at the layout's exact orientations;
//   - at 50 and 100 the valley shows first with every model built at 10 voxels
//     per metre and drawn 5 or 10 times enlarged; the fine models are generated
//     in the background and swapped in at once (../shared/detail.ts);
//   - the terrain is refined per brick (a smooth surface, grass blades,
//     pebbles) and streamed in chunks around the view, since a 128 m valley
//     of centimetre voxels does not fit in memory at once; its height map is
//     sampled and its chunks are filled on workers
//     (../shared/terrain.ts, ../shared/ground.ts);
//   - rats roam the village as an instanced crowd, but only at a scale where
//     they come out at their real size (gen-creature's realSizeAt: 1 cm
//     voxels, 100 vox/m). At 50 or 20 a rat's legs would be under two voxels
//     thick at real size, so it would have to be built larger than life
//     (0.86 m long at 50, 2.15 m at 20); the page leaves them out instead.
//
// URL options:
//   ?vpm=20|50|100 the voxels per metre (default 50, 20 on a phone; anything
//               else snaps to the nearest; the HUD's scale button steps
//               between the default and one scale finer), ?scale= the valley
//               size as on the world page (default 4), ?variants= the models
//               per species (default 3; the world page uses 10, which matches
//               it exactly but needs over a gigabyte of GPU memory at 100),
//               ?rats= the crowd (default 60 where rats are real size, none
//               elsewhere; ?rats=N forces a crowd of N at any scale, larger
//               than life below 100, for testing), ?radius= the streamed
//               radius in metres (default 24), ?near= the ground in metres
//               the first picture waits for (default 18), ?coarse=0 no
//               coarse stage (the fine models before the first picture),
//               ?seed=, ?season=, ?time=night, ?weather=, ?rigged (rats posed
//               on the GPU), ?perf (the overlay, and the load timeline in the
//               console), ?full (desktop settings on a phone), ?e2e (hooks for
//               the input tests).
// A phone (a touch-only pointer, or storage bindings under 512 MiB) gets a
// lighter profile: 20 voxels per metre, scale 2, one variant, 20 rats (at
// 100 only), a 16 m radius and the Low preset; every option above still
// applies on its own.
// Drag the lamp (or double-tap), N for night, W for weather, as on the
// world page.

import {
  createRenderer,
  makeCamera,
  makePerf,
  makeRay,
  observeResize,
  QUALITY_PRESETS,
  resizeToDisplay,
  type PointLight,
  type Renderer,
  type Vec3,
} from "@voxolith/renderer";
import { hashSeed, seededRandom } from "@voxolith/renderer/core";
import {
  columnBoxes,
  makeChunkedWorld,
  makeInstanceLayer,
  makeVariantPool,
  orientationYaw,
  PaletteAllocator,
  trackRenderer,
  type Entity,
  type RGB,
  type Role,
  type VariantPool,
} from "@voxolith/engine";
import { makeAnimator, makeCrowd, type CrowdMember } from "@voxolith/engine/animation";
import { makeGeneratorPool, type GeneratorPool } from "@voxolith/engine/worker";
import { createInput, makeOrbitController, prepareSurface, recogniseGestures } from "@voxolith/engine/input";
import { approach, atmosphereFrame, ATMOSPHERES, makeAtmosphereTransition, timeOfDay, type AtmosphereName } from "@voxolith/engine/atmosphere";
import { buildRoles, fineTerrainInit, refineTerrain } from "@voxolith/gen-terrain";
import { atScale, generateCreature, minVoxelsPerMetre, PRESETS as RATS, realSizeAt } from "@voxolith/gen-creature";
import { layoutValley, paletteKey, TILE, valleySites, valleySpecies, valleyTerrainParams, workerSeed, type Season } from "../world/layout";
import { boot, runLoop } from "../shared/boot";
import { markFrames, nextFrame, prepared, reportLoadTimeline } from "../shared/loading";
import { buildAround, groundFill } from "../shared/ground";
import { terrainOffThread } from "../shared/terrain";
import { commitStatic, sceneWorker } from "../shared/placement";
import { STEPS, type LoadingStep } from "../shared/loading-screen";
import { COARSE_STEPS, COARSE_VPM, coarseFactor, FINE_STEPS, stagedLoad, swapToFine } from "../shared/detail";
import { isPhone, pickScale, SCALES, voxelSize } from "../shared/scale";

const params = new URLSearchParams(location.search);
const seed = hashSeed(params.get("seed") ?? "voxolith");
const season = (params.get("season") ?? "summer") as Season;
const num = (key: string, fallback: number) => (params.has(key) ? Number(params.get(key)) : fallback);

/**
 * The loading screen's rows, in this order (phases not listed are not shown, but stay on the
 * tracker for window.loadTimeline and ?perf). The rats' row only where there are rats, which
 * depends on the scale, which depends on the GPU (a phone): so boot shows the list without it,
 * and the page sets it once it knows. So does the coarse stage (at 50 and 100 vox/m): then the
 * rows before the first picture are its steps, and the fine models are generated, uploaded and
 * placed after it, in the corner pill. The ground streams on after the first picture too.
 */
const loadingSteps = (rats: boolean, coarse: boolean): LoadingStep[] => [
  STEPS.device,
  { phase: "terrain", label: "Shaping the terrain" },
  { phase: "layout", label: "Laying out the valley" },
  coarse ? COARSE_STEPS.models : STEPS.models,
  ...(rats ? [{ phase: "creatures", label: "Generating rats" }] : []),
  STEPS.shaders,
  STEPS.pipelines,
  coarse ? COARSE_STEPS.upload : STEPS.encodedUpload,
  STEPS.placement,
  { ...STEPS.ground, background: true },
  ...(coarse ? FINE_STEPS : []),
];

const app = await boot("valley", { blurb: "The valley, refined and streamed", steps: loadingSteps(false, false) });
if (app) {
  const { gpu, canvas, info, load, screen } = app;
  // One tracker for the whole load (boot's): the generator workers, the renderer, the instance
  // layer and the chunked ground report into it, the page adds phases of its own (terrain, houses,
  // layout, creatures), and the loading screen shows it: full screen until the valley is up, then
  // the ground still streaming in the corner.

  // A phone gets a lighter valley: 5 cm voxels, a smaller map, one model per
  // species and the Low preset. Told apart by a touch-only pointer or the
  // small storage bindings mobile GPUs offer. ?full asks for the desktop
  // settings; every setting below can still be given on its own.
  const phone = isPhone(gpu, params);
  // 50 voxels per metre (2 cm) by default, 20 (5 cm) on a phone; 100 (1 cm)
  // is still too heavy for a desktop GPU. The HUD's scale button reloads one
  // scale finer, or back (?vpm=), since every model is generated for its scale.
  /** Voxels per metre here (20, 50 or 100), and the factor over the world page's 10. */
  const VPM = pickScale(params, phone);
  const title = document.querySelector("#hud .brand small");
  if (title) title.textContent = `valley · ${voxelSize(VPM)} voxels`;
  const K = VPM / 10;
  /** Lengths below are written for 1 cm voxels; this scales them to VPM. */
  const cm = VPM / 100;
  const SPAN = Math.max(1, Math.min(8, Math.round(num("scale", phone ? 2 : 4))));
  const COARSE = { x: TILE * SPAN, y: 192, z: TILE * SPAN };
  const SIZE = { x: COARSE.x * K, y: COARSE.y * K, z: COARSE.z * K };
  const VARIANTS = Math.max(1, Math.min(10, num("variants", phone ? 1 : 3)));
  // Rats only where every variant comes out at its real size (100 vox/m of
  // the three), unless ?rats= asks for them anyway.
  const RAT_KINDS = ["rat", "grey rat", "lab rat", "black rat"];
  const ratsReal = RAT_KINDS.every((k) => realSizeAt(RATS[k], VPM));
  const RAT_COUNT = Math.max(0, Math.min(400, num("rats", ratsReal ? (phone ? 20 : 60) : 0)));
  /** The HUD's note when rats were left out: the coarsest scale at which they are real size. */
  const ratScale = SCALES.find((s) => RAT_KINDS.every((k) => s >= minVoxelsPerMetre(RATS[k])));
  const ratsNote = !RAT_COUNT && !params.has("rats") && ratScale ? `rats at ${voxelSize(ratScale)}` : `${RAT_COUNT} rats`;
  /**
   * Metres of ground around the view's target that the first picture waits for. The first view
   * looks down on the village from 26 m and reaches nearly to the streamed edge, so it needs most
   * of the radius: with streaming stopped at the first picture, 12 m leaves sky showing through
   * the ground at the sides and 16 m at the far corners at 100 vox/m.
   */
  const NEAR_M = 18;
  /** Streamed radius, in voxels (given in metres). */
  const RADIUS = Math.max(8, num("radius", phone ? 16 : 24)) * VPM;
  /**
   * Ground built around the view's target before the first picture (?near=, metres); the rest of
   * RADIUS streams in after it, nearest first.
   */
  const NEAR = Math.max(0, Math.min(RADIUS / VPM, num("near", NEAR_M))) * VPM;
  /** The coarse stage's factor: models built at 10 vox/m drawn KC times enlarged (1: none, at 20). */
  const KC = coarseFactor(VPM, params);
  if (RAT_COUNT || KC > 1) screen.setSteps(loadingSteps(RAT_COUNT > 0, KC > 1));

  // --- the models, on workers ------------------------------------------------------------
  // Asked for first, so the workers generate (or read their cache) while this thread shapes the
  // terrain. Coarse first (at 50 and 100): every species at 10 vox/m, drawn KC times enlarged,
  // then the fine ones on the same workers, swapped in once encoded and baked
  // (../shared/detail.ts). At 20 the fine models come first; only the houses are asked for at 10
  // too, since the layout measures them (footprint, door) at its own scale. The pool's phases are
  // filed per stage.
  const species = valleySpecies(seed, season, VARIANTS);
  const isHouse = (key: string) => key.startsWith("house:");
  const staged = stagedLoad(load);
  const workers = makeGeneratorPool({ spawn: () => new Worker(new URL("../world/gen.worker.ts", import.meta.url), { type: "module" }), load: staged.tracker });
  /** What produced each model (the pool's key): the scene worker's cache keeps its encoding under it. */
  const modelKey: GeneratorPool["modelKey"] = workers.modelKey;
  /** The species `only` keeps, at `vpm`: the entities by species key, in variant order. */
  const generate = async (vpm: number, only: (key: string) => boolean = () => true) => {
    const kept = species.map((sp, si) => ({ sp, si })).filter(({ sp }) => only(sp.key));
    const out = await workers.generateMany(kept.flatMap(({ sp, si }) =>
      Array.from({ length: sp.count }, (_, n) => ({ generator: sp.generator, params: sp.params(n), seed: workerSeed(seed, si, n), entityId: `${sp.key}-${n}`, ctx: { voxelsPerMetre: vpm } })),
    ));
    const m = new Map<string, Entity[]>();
    let i = 0;
    for (const { sp } of kept) { m.set(sp.key, out.slice(i, i + sp.count)); i += sp.count; }
    return m;
  };
  const t0 = performance.now();
  const coarse = generate(COARSE_VPM, KC > 1 ? undefined : isHouse);
  if (KC > 1) staged.fine("models");
  const fine = generate(VPM);
  void fine.then(() => console.log(`[valley] ${species.reduce((n, sp) => n + sp.count, 0)} models at ${VPM} vox/m in ${((performance.now() - t0) / 1000).toFixed(1)} s`));
  // Not awaited: destroying lets the workers finish their cache writes.
  void fine.finally(() => void workers.destroy()).catch(() => {});

  // --- the terrain, on a worker ------------------------------------------------------
  // Sampling the valley's height map takes about a second, so a worker does it (../shared/terrain.ts)
  // while this thread makes the renderer and the workers above generate; the page gets the same
  // terrain the world page makes on its own thread.
  const terrainTask = load.task("terrain");
  const shaped = terrainOffThread(valleyTerrainParams(SPAN), seed).finally(() => terrainTask.end());

  // --- palette ----------------------------------------------------------------------
  // The world's palette holds only what is in the world: terrain and paths.
  // Every model draws from a palette of its own (the instance layer's), so
  // there is no 255-slot budget to share between species. The terrain's roles depend only on
  // its colours, so the palette (and the renderer) need not wait for its heights.
  const palette = new PaletteAllocator(1);
  const { base: terrainBase } = palette.allocate(buildRoles(valleyTerrainParams(SPAN).colors), "terrain");
  const settlement: Role[] = [
    { id: "path", name: "Path", color: [0.46, 0.38, 0.27] },
    { id: "path.worn", name: "Path worn", color: [0.53, 0.46, 0.34] },
    { id: "yard", name: "Trodden turf", color: [0.36, 0.42, 0.24] },
  ];
  const { base: s0 } = palette.allocate(settlement, "settlement");

  let rats: Entity[] = [];
  if (RAT_COUNT) {
    const task = load.task("creatures", RAT_KINDS.length);
    await nextFrame();
    rats = RAT_KINDS.map((k, i) => { const e = generateCreature(atScale(RATS[k], VPM), seededRandom(seed + i * 97), k).entity; task.tick(); return e; });
    task.end();
  }

  // --- renderer ---------------------------------------------------------------------
  // deferPipelines: nothing is compiled until `prepare` below, so the whole compile is awaited
  // (and timed as the "pipelines" step) instead of stalling the first frame.
  const renderer: Renderer = await createRenderer(gpu, { size: SIZE, palette: palette.buildPalette(), materials: palette.buildMaterials() }, { onLoad: trackRenderer(load), deferPipelines: true });
  renderer.setClipBounds([0, 0, 0], [SIZE.x - 1, SIZE.y - 1, SIZE.z - 1]);
  const quality = gpu.software || phone ? "low" : "medium";
  // Rays cross thousands of voxels of air here; the 64-voxel skip keeps
  // that cheap, but the step caps have to allow for the canopy and the ground.
  renderer.setQuality({ ...QUALITY_PRESETS[quality], maxSteps: gpu.software || phone ? 768 : 2048, shadowSteps: quality === "low" ? 0 : 320 });
  // A CPU adapter would take many seconds over the first full-size frame
  // before the scale controller reacts, so it starts small.
  if (gpu.software) gpu.renderScale = Math.min(gpu.renderScale, 0.3);
  else if (phone) gpu.renderScale = Math.min(gpu.renderScale, 0.6);
  // Compile what the frames will use while the scenery is placed: instances (the scenery is not
  // placed yet, so say so), and instances posed on the GPU for ?rigged rats. Awaited before the
  // first frame.
  // The coarse stage draws scaled models, a variant of its own: the unscaled one is compiled
  // alongside and awaited before the swap, so neither compiles on a frame.
  const parts = RAT_COUNT > 0 && params.has("rigged");
  const compiled = prepared(renderer.prepare({ instances: true, parts, scaled: KC > 1 }));
  const compiledFine = KC > 1 ? prepared(renderer.prepare({ instances: true, parts })) : compiled;

  // --- the valley's design, at the world page's scale ------------------------------
  const terrain = await shaped;
  const sites = valleySites(terrain, SPAN);
  // The layout measures the houses at its scale: the 10 vox/m models from the workers.
  const houses = await coarse;
  const layout = load.task("layout");
  const models = new Map([...houses].filter(([key]) => isHouse(key)));
  // The scatter only needs a variant's index and orientation; the entity it
  // hands back is replaced by the placed model below.
  const pools = new Map<string, VariantPool>();
  for (const sp of species) pools.set(sp.key, makeVariantPool({ count: sp.count, make: () => null as unknown as Entity }));
  const valley = layoutValley({ terrain, span: SPAN, seed, season, models, pools, sites });
  const topOverride = valley.topOverride({ path: s0, pathWorn: s0 + 1, yard: s0 + 2 });
  layout.end();

  const ground = refineTerrain(terrain, K, { seed });
  // The ground's bricks are filled on workers (../shared/ground.ts), from the levelled terrain and
  // the settlement's surface as they are now: nothing edits the heights after this.
  const fill = groundFill({ fine: fineTerrainInit(ground, topOverride), base: terrainBase });

  // --- the ground, streamed ---------------------------------------------------------------
  const CHUNK = 256;
  /** Chunks built so far, for the e2e check that moving streams new ground. */
  let built = 0;
  const world = makeChunkedWorld({
    target: renderer,
    size: SIZE,
    chunk: CHUNK,
    seed,
    load,
    fill,
    // A box per 8x8 brick column, sized to what the column holds: the fine terrain answers a
    // column's bricks in a run.
    boxes: ({ box }) => columnBoxes(box, (ox, oz) => ground.columnSpan(ox, oz)),
    // Runs once a chunk's bricks are in.
    generate() {
      built++;
    },
  });
  // Where the camera starts (the village, or the glade at night): focused now, so the workers
  // fill the ground there while this thread sets up the scenery. Chunks are only copied in by
  // `step`, from the loading wait below and then the frame loop.
  const night0 = params.get("time") === "night";
  const [vx, vz] = [sites.VC[0] * K, sites.VC[1] * K];
  const start: [number, number] = night0 ? [sites.GC[0] * K, sites.GC[1] * K] : [vx, vz];
  world.focus(start[0], start[1], RADIUS, RADIUS * 1.3);
  /** The first stage's models: coarse at 50 and 100, fine at 20. */
  const first = KC > 1 ? houses : await fine;
  // The static scenery's models are encoded and the set baked on a worker (commitAsync below), so
  // the page keeps painting.
  const worker = sceneWorker();
  // Every static model comes from the pool (the rats are dynamic), so each has a key.
  const layer = makeInstanceLayer(renderer, { load: staged.tracker, worker, modelKey });
  // One palette per species (rocks sharing a skin share one; every scale of a model has the same
  // roles, so both stages share them)...
  const baseOf = (key: string) => layer.palettes.of(paletteKey(key), first.get(key)![0].model.roles);
  // ...and one per house: each gets its own plaster or brick, roof and paint,
  // a shade either way of its style's, so no two houses in the village match.
  const houseBase = (key: string, n: number) => {
    const h = (salt: number) => ((Math.imul(n + 1, 0x9e3779b1) ^ Math.imul(salt, 0x85ebca77)) >>> 0) / 4294967296;
    const shade = (c: RGB, f: number, warm: number): RGB => [
      Math.min(1, c[0] * f * (1 + warm)), Math.min(1, c[1] * f), Math.min(1, c[2] * f * (1 - warm)),
    ];
    const wall = 0.88 + 0.24 * h(1), wallWarm = (h(2) - 0.5) * 0.12, roof = 0.8 + 0.35 * h(3), paint = h(4);
    return layer.palettes.of(`${key}#${n}`, first.get(key)![0].model.roles, (c, r) => {
      if (r.id.startsWith("wall") || r.id === "brick.exposed") return shade(c, wall, wallWarm);
      if (r.id.startsWith("roof") || r.id === "ridge") return shade(c, roof, 0);
      // Doors and shutters: a painted colour of its own.
      if (r.id.startsWith("door") || r.id.startsWith("shutter")) {
        const hue: RGB = paint < 0.33 ? [0.2, 0.35, 0.3] : paint < 0.66 ? [0.45, 0.16, 0.14] : [0.18, 0.24, 0.42];
        return r.id.endsWith("dark") ? [hue[0] * 0.7, hue[1] * 0.7, hue[2] * 0.7] : hue;
      }
      return c;
    });
  };
  const ratBase = rats.map((e, i) => layer.palettes.of(`rat${i}`, e.model.roles));

  // Scenery: every house and every plant and rock of the layout, placed where
  // the world page stamps it, turned the same way.
  // Spots first (species and variant), then the placements of either stage's models on them.
  const spots: { key: string; variant: number; x: number; y: number; z: number; yaw: number; mirror: boolean; base: number }[] = [];
  let trees = 0, rocks = 0, plants = 0;
  for (const [hi, h] of valley.houses.entries()) {
    const { yaw, mirror } = orientationYaw(h.orientation);
    spots.push({ key: h.key, variant: h.variant, x: h.x * K, y: h.y * K, z: h.z * K, yaw, mirror, base: houseBase(h.key, hi) });
  }
  valley.scatter(0, 0, COARSE.x - 1, COARSE.z - 1, (pt) => {
    const { yaw, mirror } = orientationYaw(pt.variant.orientation);
    const x = pt.x * K, z = pt.z * K;
    spots.push({ key: pt.key, variant: pt.variant.index, x, y: ground.heightAt(x + K / 2, z + K / 2) + 1, z, yaw, mirror, base: baseOf(pt.key) });
    if (pt.layer === "tree") trees++;
    else if (pt.layer === "rock") rocks++;
    else plants++;
  }, false);
  // Encoding the models (the engine's "upload") and indexing the instances ("placement") run on
  // the worker; the main thread only adds the encoded models, a few per frame. The ground streams
  // in meanwhile, and the first picture waits for both below.
  /** The static set for one stage's models, drawn `scale` times enlarged. */
  const statics = (models: Map<string, Entity[]>, scale: number) => spots.map(({ key, variant, ...s }) => {
    const list = models.get(key)!;
    return { ...s, model: list[variant % list.length].model, scale };
  });
  layer.setStatic(statics(first, KC));
  const placed = commitStatic(layer);

  // --- rats ---------------------------------------------------------------------------------
  interface Rat extends CrowdMember { speed: number; turn: number; timer: number; }
  // ?rigged poses the rats on the GPU from one rest model per variant instead of baking poses.
  const crowd = RAT_COUNT === 0 ? null : makeCrowd({ instances: layer, rigged: params.has("rigged"), near: 3000 * cm, farFps: 6, freeze: 12000 * cm, budgetMs: 4 });
  const rng = seededRandom(seed ^ 0x51ed);
  const members: Rat[] = [];
  for (let i = 0; i < RAT_COUNT; i++) {
    const k = i % rats.length;
    const anim = makeAnimator(rats[k], "walk");
    anim.update(rng() * 3);
    let x = 0, z = 0;
    for (let t = 0; t < 50; t++) {
      // Inside the valley too: at ?scale=1 the 30 m square overhangs its edge.
      x = Math.max(60 * cm, Math.min(SIZE.x - 60 * cm, vx + (rng() - 0.5) * 3000 * cm));
      z = Math.max(60 * cm, Math.min(SIZE.z - 60 * cm, vz + (rng() - 0.5) * 3000 * cm));
      if (!ground.waterAt(x, z) && !valley.inHouse(Math.floor(x / K), Math.floor(z / K), 2)) break;
    }
    members.push({ id: i + 1, entity: rats[k], variant: `rat${k}`, anim, base: ratBase[k], x, y: 0, z, yaw: rng() * Math.PI * 2, speed: 40, turn: 0, timer: rng() * 4 });
  }
  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  const blocked = (x: number, z: number) =>
    x < 50 * cm || z < 50 * cm || x > SIZE.x - 50 * cm || z > SIZE.z - 50 * cm || ground.waterAt(x, z) || valley.inHouse(Math.floor(x / K), Math.floor(z / K), 1);
  const think = (r: Rat, dt: number) => {
    r.timer -= dt;
    if (r.timer <= 0) {
      const c = ["walk", "walk", "idle", "sniff", "run"][Math.floor(rng() * 5)];
      r.anim.play(c, { fade: 0.25 });
      // Real rat speeds: about half a metre a second walking, two running.
      r.speed = (c === "walk" ? 45 : c === "run" ? 180 : 0) * cm;
      r.turn = r.yaw + (rng() - 0.5) * 2.4;
      r.timer = 1.5 + rng() * 4;
    }
    if (r.speed > 0) {
      r.yaw += Math.max(-1.5 * dt, Math.min(1.5 * dt, wrap(r.turn - r.yaw)));
      const nx = r.x + Math.sin(r.yaw) * r.speed * dt, nz = r.z + Math.cos(r.yaw) * r.speed * dt;
      if (blocked(nx, nz)) { r.yaw += Math.PI * 0.8; r.turn = r.yaw; }
      else { r.x = nx; r.z = nz; }
    }
    r.y = ground.heightAt(r.x, r.z) + 1;
    r.anim.update(dt);
  };

  // --- camera -------------------------------------------------------------------------
  const camera = makeCamera({ target: [vx, 0, vz], distance: 2600 * cm, pitchDeg: 38, fovDeg: 42 });
  prepareSurface(canvas, { contextMenu: false });
  const input = createInput(canvas, { loop: { invalidate: () => loop.invalidate() } });
  const orbit = makeOrbitController(input, {
    yaw: 35, pitchLimits: [8, 85], distanceLimits: [150 * cm, RADIUS * 0.8], fovDeg: 42, pan: "secondary",
    onChange: () => perf.reprobe(),
    panBounds: { minX: 0, maxX: SIZE.x, minZ: 0, maxZ: SIZE.z },
    target: [start[0], ground.heightAt(start[0], start[1]) + 60 * cm, start[1]],
    pitch: night0 ? 45 : 38,
    distance: (night0 ? 1800 : 2600) * cm,
  });
  const frame = () => camera(orbit.yaw(), orbit.distance(), orbit.target(), orbit.pitch());
  const perf = makePerf({ enabled: params.has("perf"), scale: gpu.renderScale, minScale: gpu.software ? 0.25 : 0.35, maxSampleMs: 4000, retryAfterMs: Infinity });

  // --- time of day, weather, lamp (as on the world page) --------------------------------
  const TRANSITION_S = 2.5;
  let phase = night0 ? 1.0 : 0.5;
  let phaseTarget = phase;
  const WEATHERS: AtmosphereName[] = ["clear", "cloudy", "rain", "storm", "snow", "fog"];
  const w0 = (params.get("weather") ?? "clear") as AtmosphereName;
  let weatherName: AtmosphereName = w0 in ATMOSPHERES ? w0 : "clear";
  const weather = makeAtmosphereTransition(ATMOSPHERES[weatherName]);
  let wetness = weatherName === "rain" || weatherName === "storm" ? 0.8 : 0;
  let snowCover = weatherName === "snow" ? 0.75 : 0;
  const stepGround = (dt: number) => {
    const p = weather.current().precipitation;
    const raining = p.kind === "rain" ? p.intensity : 0;
    const snowing = p.kind === "snow" ? p.intensity : 0;
    wetness = raining > 0 ? approach(wetness, 1, 0.12 * raining, dt) : approach(wetness, 0, 0.02, dt);
    if (snowing > 0) snowCover = approach(snowCover, 0.9, 0.05 * snowing, dt);
    else snowCover = approach(snowCover, 0, raining > 0 ? 0.05 : 0.012, dt);
  };

  const HOVER = 70 * cm;
  const lamp: Vec3 = [sites.GC[0] * K, 0, sites.GC[1] * K];
  const standAt = (x: number, z: number) => Math.max(ground.heightAt(x, z), ground.waterAt(x, z) ? ground.waterTop : 0) + HOVER;
  lamp[1] = standAt(lamp[0], lamp[2]);
  const updateLamp = () => {
    const lights: PointLight[] = [
      { position: lamp, color: [1.0, 0.7, 0.38], intensity: 2.6, range: 900 * cm, glow: 35 * cm },
      { position: lamp, color: [1.0, 0.75, 0.45], intensity: 0.25, range: 500 * cm, shadows: false },
    ];
    renderer.setLights(lights);
    loop.invalidate();
  };

  // A light haze, whatever the weather, so the streamed edge at the horizon
  // softens; the zoom limit keeps the camera well inside it.
  const edgeFog = 0.1 / RADIUS;
  // No frame before the pipelines are compiled (one would compile them synchronously).
  await compiled;
  let spin = true;
  let last = performance.now();
  const loop = runLoop((now, dt) => {
    const step = Math.min(0.05, (now - last) / 1000);
    last = now;
    stream();
    for (const r of members) think(r, step);
    const f = frame();
    if (crowd) crowd.update(members, f.camPos as [number, number, number]);
    else layer.commit();
    perf.frame(now);
    gpu.renderScale = perf.scale();
    resizeToDisplay(gpu);
    if (spin) orbit.set({ yaw: orbit.yaw() + dt * 2.4 });
    if (phase < phaseTarget) phase = Math.min(phaseTarget, phase + dt * (0.5 / TRANSITION_S));
    const sky = weather.update(dt);
    stepGround(dt);
    const atm = atmosphereFrame(timeOfDay(phase), { ...sky, wetness, cover: snowCover }, { voxelsPerMetre: VPM });
    const fog = atm.fog && atm.fog.density > edgeFog ? atm.fog : { density: edgeFog, color: atm.skyHorizon, heightFalloff: 0 };
    renderer.render({ ...f, ...atm, fog, time: now / 1000 });
  }, true);
  observeResize(canvas, loop);
  updateLamp();
  input.on((e) => {
    if (e.kind === "pointer" && e.phase === "down") spin = false;
  });

  const lampOnScreen = (): [number, number] | null => {
    const f = frame();
    const v: Vec3 = [lamp[0] - f.camPos[0], lamp[1] - f.camPos[1], lamp[2] - f.camPos[2]];
    const z = v[0] * f.camFwd[0] + v[1] * f.camFwd[1] + v[2] * f.camFwd[2];
    if (z <= 0) return null;
    const x = (v[0] * f.camRight[0] + v[1] * f.camRight[1] + v[2] * f.camRight[2]) / z;
    const y = (v[0] * f.camUp[0] + v[1] * f.camUp[1] + v[2] * f.camUp[2]) / z;
    const rect = canvas.getBoundingClientRect();
    const aspect = canvas.width / canvas.height;
    return [rect.left + ((x / (aspect * f.tanHalfFov) + 1) / 2) * rect.width, rect.top + ((1 - y / f.tanHalfFov) / 2) * rect.height];
  };
  const moveLampTo = (clientX: number, clientY: number) => {
    const { origin, dir } = makeRay(canvas, frame(), clientX, clientY);
    const hit = ground.pick(origin, dir, { water: true });
    if (!hit) return;
    lamp[0] = hit[0]; lamp[2] = hit[2]; lamp[1] = standAt(hit[0], hit[2]);
    updateLamp();
  };
  const nearLamp = (x: number, y: number) => { const s = lampOnScreen(); return !!s && Math.hypot(x - s[0], y - s[1]) < 32; };
  const lampOwner = {};
  input.on((e) => {
    if (e.kind !== "pointer") return;
    const p = e.pointer;
    if (e.phase === "down") {
      if ((p.type !== "mouse" || p.button === 0) && nearLamp(p.x, p.y) && input.claim(p.id, lampOwner)) canvas.style.cursor = "grabbing";
    } else if (input.claimedBy(p.id) === lampOwner) {
      if (e.phase === "move") moveLampTo(p.x, p.y);
      else canvas.style.cursor = "";
    }
  }, 10);
  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerType === "mouse" && e.buttons === 0) canvas.style.cursor = nearLamp(e.clientX, e.clientY) ? "grab" : "";
  });
  recogniseGestures(input, { doubleTap: (t) => moveLampTo(t.x, t.y) });

  const timeBtn = document.getElementById("time-toggle") as HTMLButtonElement | null;
  const isNight = () => Math.round(phaseTarget * 2) % 2 === 0;
  const syncButton = () => {
    if (!timeBtn) return;
    timeBtn.textContent = isNight() ? "Day" : "Night";
    timeBtn.title = isNight() ? "Switch to day (N)" : "Switch to night (N)";
  };
  const toggleTime = () => {
    phaseTarget = Math.floor(phaseTarget * 2 + 1e-6) / 2 + 0.5;
    if (phase > phaseTarget) phase = phaseTarget - 0.5;
    syncButton();
  };
  timeBtn?.addEventListener("click", toggleTime);
  input.captureKeys(["KeyN", "KeyW"]);
  const weatherSel = document.getElementById("weather") as HTMLSelectElement | null;
  const setWeather = (name: AtmosphereName, seconds = 4) => {
    weatherName = name;
    weather.set(ATMOSPHERES[name], seconds);
    if (weatherSel) weatherSel.value = name;
  };
  input.on((e) => {
    if (e.kind !== "key" || e.phase !== "down" || e.repeat) return;
    if (e.code === "KeyN") toggleTime();
    if (e.code === "KeyW") setWeather(WEATHERS[(WEATHERS.indexOf(weatherName) + 1) % WEATHERS.length]);
  });
  if (weatherSel) {
    for (const name of WEATHERS) {
      const o = document.createElement("option");
      o.value = name;
      o.textContent = name[0].toUpperCase() + name.slice(1);
      weatherSel.append(o);
    }
    weatherSel.value = weatherName;
    weatherSel.addEventListener("change", () => setWeather(weatherSel.value as AtmosphereName));
  }
  syncButton();

  // --- streaming ------------------------------------------------------------------------
  let focusX = NaN, focusZ = NaN;
  function stream(): void {
    const [tx, , tz] = orbit.target();
    if (!(Math.abs(tx - focusX) < CHUNK / 2 && Math.abs(tz - focusZ) < CHUNK / 2)) {
      focusX = tx; focusZ = tz;
      world.focus(tx, tz, RADIUS, RADIUS * 1.3);
    }
    // Frame-safe: a chunk takes about 10 ms to copy in at 100 vox/m, and at least one is applied.
    if (world.pending) world.step(8);
  }
  world.focus(orbit.target()[0], orbit.target()[2], RADIUS, RADIUS * 1.3);
  focusX = orbit.target()[0]; focusZ = orbit.target()[2];
  // Build the ground within NEAR of the view's target before showing the page; the rest streams in.
  // readyAround tests chunk centres, so half a chunk's diagonal more takes every chunk that
  // reaches into the disc; never more than the focus queues, or it would wait forever.
  // Behind the loading screen the main thread has nothing better to do than copy chunks in.
  await buildAround(world, focusX, focusZ, Math.min(RADIUS, NEAR + CHUNK * Math.SQRT1_2), 40);
  await placed;
  // From here the HUD shows the valley's summary, and the loading screen's corner pill the chunks
  // still to come.
  screen.ready();
  markFrames(load, renderer);

  const acc = { frames: 0, t: performance.now() };
  const report = () => {
    const now = performance.now(), secs = (now - acc.t) / 1000, st = renderer.instanceStats();
    info.textContent =
      `${VPM} voxels/m${phone ? " (phone settings; ?full for all)" : ""} · ${valley.houses.length} houses, ${trees} trees, ${rocks} rocks, ${plants} plants, ${ratsNote} · ` +
      `${st.instances} instances of ${st.models} models · ${world.resident} chunks${world.pending ? ` (+${world.pending})` : ""} · ` +
      `${(st.bytes / 1048576).toFixed(0)} MB on the GPU · ${secs > 0.1 ? (acc.frames / secs).toFixed(0) : "–"} fps · drag the lamp · N night/day · W weather`;
    acc.frames = 0; acc.t = now;
  };
  const countFrames = () => { acc.frames++; requestAnimationFrame(countFrames); };
  requestAnimationFrame(countFrames);
  setInterval(report, 1000);
  report();
  void reportLoadTimeline(load, { perf: params.has("perf"), overlay: perf });

  // --- the fine set, swapped in -----------------------------------------------------------
  // The coarse set draws until the fine bake applies; then its models are released. The rats'
  // crowd commits the layer every frame, which only sends its moving set meanwhile.
  let detail = KC === 1;
  if (KC > 1) {
    void (async () => {
      const models = await fine;
      await compiledFine;
      await swapToFine(staged, layer, statics(models, 1));
      detail = true;
    })()
      .catch((err) => screen.fail(err))
      .finally(() => void worker.destroy());
  } else void placed.finally(() => void worker.destroy());

  if (params.has("e2e")) {
    Object.assign(window, {
      valleyStats: () => ({ ...renderer.instanceStats(), houses: valley.houses.length, trees, rocks, plants, rats: members.length, resident: world.resident, pending: world.pending, built, detail, first: members[0] ? { x: members[0].x, z: members[0].z } : null, ratSum: members.reduce((n, r) => n + r.x + r.z, 0) }),
      valleyPlaces: { village: [vx, vz], glade: [sites.GC[0] * K, sites.GC[1] * K], get rat() { return members[0] ? [members[0].x, members[0].z] : [vx, vz]; } },
      valleyLook: (x: number, z: number, distance: number, pitch: number, yaw?: number) => {
        spin = false;
        orbit.set({ target: [x, ground.heightAt(x, z) + 60 * cm, z], distance: distance * cm, pitch, ...(yaw === undefined ? {} : { yaw }) });
      },
      valleyWeather: (name: AtmosphereName) => setWeather(name, 0),
      valleyLamp: () => lampOnScreen(),
    });
  }
}
