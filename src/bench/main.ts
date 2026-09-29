// bench — one fixed, deterministic scene for measuring the renderer, at 20, 50 or 100 voxels per metre.
//
// Not a showcase: a test scene small enough to build in a few seconds at 20 voxels per metre and
// still tolerable at 100, which takes every expensive path the renderer has, so one run at each
// scale settles whether a renderer change is faster or slower (the workspace's render-bench tool
// drives it). A 40 m square of ground at dusk holds:
//   - a dense patch of instanced wood: oak, birch and spruce with bushes, bracken and grass;
//   - open ground with boulders stamped into the world (not instanced) and a cottage with its
//     windows lit (emissive glass);
//   - a pond (the water material, animated from the frame's time);
//   - two shadowed point lights (a lantern at the cottage door, a lamp in the wood) and four
//     unshadowed ones;
//   - fog with a view distance (fog.distance), so every primary ray stops within 32 m;
//   - a dynamic set: four small stones circling the pond;
//   - six rats posed on the GPU (makeCrowd rigged), walking a circle by the pond. They are sized
//     with gen-creature's atScale whatever the scale, so below 100 voxels per metre they are
//     larger than life: this page is a test, not a scene.
//
// Nothing depends on the clock: the seed is fixed, nothing calls Math.random, and whatever moves
// (stones, rats, water) advances a fixed 1/60 s per drawn frame, so two runs draw the same frames
// (?anim=1 follows the wall clock instead). The camera stands at one of four fixed views, the
// render scale is fixed (no makePerf) and every frame is drawn. Every length is in metres, so the
// scene is the same at every scale. There is no phone profile: it runs as asked everywhere.
//
// URL options:
//   ?vpm=20|50|100  voxels per metre (default 20; anything else snaps to the nearest)
//   ?view=0..3|all  the camera: 0 inside the wood, 1 across the open ground, 2 close on the cottage
//                   and the pond, 3 up at the treetops and the sky (default 0; `all` starts at 0,
//                   and bench.setView() with no argument steps to the next)
//   ?renderScale=   the fixed render scale (default 0.5)
//   ?quality=       low, medium or high (default high; low on a CPU adapter); maxSteps is 1024 in
//                   every preset, since fog.distance bounds the rays
//   ?anim=1         move things by the wall clock instead of the frame counter
//   ?e2e            expose window.bench (below), for tools
//   ?diag           the adapter's limits in the HUD (shared/boot.ts)
//
// window.bench, with ?e2e:
//   ready(): boolean                    everything generated, placed, streamed, and a frame drawn
//   setView(i?: number): void           one of the four views (none: the next one)
//   frames(n): Promise<void>            resolves once n more frames have been drawn and the GPU
//                                       has finished them
//   stats(): { vpm, view, fps, gpuMs, width, height, models, instances,
//              loadMs: { generate, upload, place, ground, pipelines, total } }
//   setDebug(v: number): void           renderer.setDebug
//   setQuality(patch | null): void      renderer.setQuality(patch); null restores the page's own
//                                       starting quality (its preset plus maxSteps 1024)
//   freeze(on: boolean): void           while on, nothing advances: no motion step, the crowd and
//                                       the dynamic set stay put, and the time given to the
//                                       renderer is held (still water); frames are still drawn.
//                                       freeze(false) resumes from the same state (the motion's
//                                       frame counter does not advance while frozen)
//   setViewDistance(v | null): void     caps the frame's fog.distance (voxels) at min(page's, v);
//                                       e.g. so a no-skip walk's step cap is not reached first;
//                                       null restores the page's own

import { createRenderer, firstPersonFrame, observeResize, QUALITY_PRESETS, resizeToDisplay, type PointLight, type QualityPreset, type RenderQuality, type Renderer, type Vec3 } from "@voxolith/renderer";
import { hashSeed, seededRandom, sparseDims } from "@voxolith/renderer/core";
import { makeChunkedWorld, makeInstanceLayer, PaletteAllocator, trackRenderer, type Entity, type EntityModel, type InstanceLayer, type InstancePlacement } from "@voxolith/engine";
import { makeAnimator, makeCrowd, type CrowdMember } from "@voxolith/engine/animation";
import { makeGeneratorPool } from "@voxolith/engine/worker";
import { atmosphereFrame, ATMOSPHERES, timeOfDay } from "@voxolith/engine/atmosphere";
import { generateTerrain, refineTerrain } from "@voxolith/gen-terrain";
import { PRESETS as TREES } from "@voxolith/gen-tree";
import { PRESETS as BUSHES } from "@voxolith/gen-bush";
import { PRESETS as GRASSES } from "@voxolith/gen-grass";
import { PRESETS as ROCKS, cloneParams as cloneRock } from "@voxolith/gen-rock";
import { PRESETS as BUILDINGS } from "@voxolith/gen-building";
import { atScale, generateCreature, PRESETS as RATS } from "@voxolith/gen-creature";
import { boot, runLoop } from "../shared/boot";
import { markFrames, nextFrame, prepared, reportLoadTimeline } from "../shared/loading";
import { STEPS } from "../shared/loading-screen";
import { pickScale, voxelSize } from "../shared/scale";

const tStart = performance.now();
const params = new URLSearchParams(location.search);
const seed = hashSeed("bench");
const num = (key: string, fallback: number) => (params.has(key) && Number.isFinite(Number(params.get(key))) ? Number(params.get(key)) : fallback);

// The loading screen's rows, in this order (phases not listed are not shown, but stay on the
// tracker for window.loadTimeline and ?perf).
const app = await boot("bench", {
  blurb: "The renderer benchmark scene",
  steps: [
    STEPS.device,
    STEPS.models,
    STEPS.shaders,
    STEPS.pipelines,
    STEPS.upload,
    STEPS.ground,
    STEPS.placement,
  ],
});
if (app) {
  // `tracker` is boot's load tracker, shown by its loading screen (`load` below is the bench's own
  // coarse timing, reported in window.bench.stats()).
  const { gpu, canvas, info, load: tracker, screen } = app;
  const VPM = pickScale(params, false, 20);
  const title = document.querySelector("#hud .brand small");
  if (title) title.textContent = `bench · ${voxelSize(VPM)} voxels`;
  /** Metres to voxels at this resolution. */
  const m = (metres: number) => metres * VPM;
  const K = VPM / 10;
  const RENDER_SCALE = Math.max(0.1, Math.min(2, num("renderScale", 0.5)));
  const ANIM = params.get("anim") === "1";
  const askedQuality = params.get("quality");
  const PRESET: QualityPreset = askedQuality === "low" || askedQuality === "medium" || askedQuality === "high" ? askedQuality : gpu.software ? "low" : "high";
  const START_QUALITY: RenderQuality = { ...QUALITY_PRESETS[PRESET], maxSteps: 1024 };
  const VIEWS = 4;
  let view = params.get("view") === "all" ? 0 : Math.max(0, Math.min(VIEWS - 1, Math.round(num("view", 0))));
  const load = { generate: 0, upload: 0, place: 0, ground: 0, pipelines: 0, total: 0 };

  // --- the design, at 10 voxels per metre ------------------------------------------------------
  // 40 m by 40 m of low ground, 24 m of air for the tallest spruce. The water surface sits below
  // all the ground but the pond's bowl, dug into the heights before anything is refined.
  const COARSE = { x: 400, y: 240, z: 400 };
  const terrain = generateTerrain(
    { width: COARSE.x, depth: COARSE.z, height: COARSE.y, baseY: 36, relief: 3, featureSize: 180, waterLevel: 30, river: { enabled: false, width: 0, depth: 0, banks: 0, meander: 100 } },
    seed,
  );
  const SIZE = { x: COARSE.x * K, y: COARSE.y * K, z: COARSE.z * K };
  // Where things are, in metres.
  const WOOD = { x: 12, z: 27, r: 10 };
  const POND = { x: 28, z: 12, r: 4.5 };
  const HOUSE = { x: 30, z: 23 };
  const RATS_AT = { x: 22.5, z: 19, r: 2.2 };
  const HOUSE_YAW = Math.atan2(POND.x - HOUSE.x, POND.z - HOUSE.z); // its front towards the pond
  const edit = (fn: (x: number, z: number, h: number) => number) => {
    const { heights, width } = terrain;
    for (let z = 0; z < COARSE.z; z++) for (let x = 0; x < COARSE.x; x++) heights[x + z * width] = fn(x / 10, z / 10, heights[x + z * width]);
  };
  {
    // The pond: a bowl 6 voxels deep under the water line, rising to meet the ground.
    const R = POND.r * 10;
    edit((x, z, h) => {
      const r = Math.hypot(x - POND.x, z - POND.z) * 10;
      return r < R ? Math.min(h, Math.round(24 + 13 * (r / R) ** 2)) : h;
    });
    // The cottage's pad: level within 5 m, blended out to 7 m.
    const hc = terrain.heights[HOUSE.x * 10 + HOUSE.z * 10 * terrain.width];
    edit((x, z, h) => {
      const d = Math.hypot(x - HOUSE.x, z - HOUSE.z);
      return d < 5 ? hc : d < 7 ? Math.round(hc + (h - hc) * ((d - 5) / 2)) : h;
    });
  }

  // --- what to generate ---------------------------------------------------------------------------
  interface Kind { key: string; generator: string; params: unknown; seed: number }
  const tree = (preset: keyof typeof TREES, height: number, age: number, n: number): Kind => {
    const p = structuredClone(TREES[preset]);
    p.shape.height = height;
    p.look.age = age;
    return { key: `tree:${preset}:${n}`, generator: preset === "spruce" || preset === "pine" ? "voxolith/tree.conifer" : "voxolith/tree.broadleaf", params: p, seed: seed + 100 + n * 977 };
  };
  const bush = (preset: keyof typeof BUSHES, height: number, n: number): Kind => {
    const p = structuredClone(BUSHES[preset]);
    p.shape.height = height;
    return { key: `bush:${preset}:${n}`, generator: "voxolith/bush", params: p, seed: seed + 5000 + n * 131 };
  };
  const grass = (preset: keyof typeof GRASSES, height: number, n: number): Kind => {
    const p = structuredClone(GRASSES[preset]);
    p.shape.height = height;
    return { key: `grass:${preset}:${n}`, generator: "voxolith/grass", params: p, seed: seed + 9000 + n * 71 };
  };
  const rock = (preset: string, size: number, n: number): Kind => {
    const p = cloneRock(ROCKS[preset]);
    p.shape.size = size;
    return { key: `rock:${preset}:${n}`, generator: "voxolith/rock", params: p, seed: seed + 15000 + n * 53 };
  };
  const cottage = structuredClone(BUILDINGS.cottage);
  cottage.look.lit = 1;
  const KINDS = {
    trees: [tree("oak", 170, 0.8, 0), tree("birch", 150, 0.5, 1), tree("spruce", 190, 0.7, 2), tree("spruce", 150, 0.5, 3)],
    bushes: [bush("bush", 14, 0), bush("thicket", 18, 1), bush("bramble", 10, 2)],
    ground: [grass("fern", 7, 0), grass("meadow", 4, 1), grass("grass", 4, 2)],
    rocks: [rock("boulder", 16, 0), rock("mossy", 12, 1), rock("basalt", 14, 2)],
    stone: rock("boulder", 6, 3),
    house: { key: "house", generator: "voxolith/house", params: cottage, seed: seed + 20000 } as Kind,
  };
  const all = [...KINDS.trees, ...KINDS.bushes, ...KINDS.ground, ...KINDS.rocks, KINDS.stone, KINDS.house];

  const fine = new Map<string, Entity>();
  let t = performance.now();
  {
    const workers = makeGeneratorPool({ spawn: () => new Worker(new URL("../world/gen.worker.ts", import.meta.url), { type: "module" }), load: tracker });
    await workers.ready();
    const out = await workers.generateMany(
      all.map((k) => ({ generator: k.generator, params: k.params, seed: k.seed, entityId: k.key, ctx: { voxelsPerMetre: VPM } })),
    );
    // Not awaited: it only lets the workers finish their cache writes.
    void workers.destroy();
    all.forEach((k, i) => fine.set(k.key, out[i]));
  }
  const RAT_KINDS = ["rat", "grey rat", "lab rat", "black rat"];
  const rats = RAT_KINDS.map((k, i) => generateCreature(atScale(RATS[k], VPM), seededRandom(seed + i * 97), k).entity);
  load.generate = performance.now() - t;

  // --- renderer ------------------------------------------------------------------------------------
  // The world palette holds what is in the world: the ground and the stamped boulders.
  const palette = new PaletteAllocator(1);
  const { base: groundBase } = palette.allocate(terrain.roles, "terrain");
  const rockBase = KINDS.rocks.map((k) => palette.allocate(fine.get(k.key)!.model.roles, k.key).base);
  const renderer: Renderer = await createRenderer(gpu, { size: SIZE, palette: palette.buildPalette(), materials: palette.buildMaterials() }, { onLoad: trackRenderer(tracker), deferPipelines: true });
  renderer.setClipBounds([0, 0, 0], [SIZE.x - 1, SIZE.y - 1, SIZE.z - 1]);
  renderer.setQuality(START_QUALITY);
  gpu.renderScale = RENDER_SCALE;

  const ground = refineTerrain(terrain, K, { seed });
  const floor = (x: number, z: number) => ground.heightAt(Math.max(0, Math.min(SIZE.x - 1, x)), Math.max(0, Math.min(SIZE.z - 1, z)));
  const layer = makeInstanceLayer(renderer, { load: tracker });
  const baseOf = (key: string) => layer.palettes.of(key, fine.get(key)!.model.roles);

  // --- the wood and the cottage, as instances -----------------------------------------------------
  const rng = seededRandom(seed ^ 0x77);
  const statics: { model: EntityModel; x: number; y: number; z: number; yaw: number; base: number }[] = [];
  const place = (key: string, x: number, z: number, yaw = rng() * Math.PI * 2) => {
    statics.push({ model: fine.get(key)!.model, x: Math.round(x), y: floor(x, z) + 1, z: Math.round(z), yaw, base: baseOf(key) });
  };
  const pick = <T>(list: readonly T[]) => list[Math.floor(rng() * list.length)];
  const [wx, wz] = [m(WOOD.x), m(WOOD.z)];
  // View 0 stands in the wood; keep a couple of metres round it clear of trunks.
  const EYE0 = { x: 9.5, z: 23.5 };
  // Trees on a jittered 2.6 m grid inside the wood.
  for (let gz = wz - m(WOOD.r); gz <= wz + m(WOOD.r); gz += m(2.6))
    for (let gx = wx - m(WOOD.r); gx <= wx + m(WOOD.r); gx += m(2.6)) {
      const x = gx + (rng() - 0.5) * m(2), z = gz + (rng() - 0.5) * m(2);
      const kind = pick(KINDS.trees), keep = rng() < 0.85;
      if (!keep || Math.hypot(x - wx, z - wz) > m(WOOD.r) || Math.hypot(x - m(EYE0.x), z - m(EYE0.z)) < m(2)) continue;
      place(kind.key, x, z);
    }
  // Shrubs and ground plants through the wood and a metre past its edge.
  const inWood = (reach: number) => {
    const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * m(WOOD.r + reach);
    return [wx + Math.sin(a) * r, wz + Math.cos(a) * r] as const;
  };
  for (let i = 0; i < 220; i++) {
    const [x, z] = inWood(0.5), kind = pick(KINDS.bushes);
    if (Math.hypot(x - m(EYE0.x), z - m(EYE0.z)) > m(1.2)) place(kind.key, x, z);
  }
  for (let i = 0; i < 360; i++) {
    const [x, z] = inWood(1.5);
    place(pick(KINDS.ground).key, x, z);
  }
  place("house", m(HOUSE.x), m(HOUSE.z), HOUSE_YAW);

  // Rats: four variants, six walkers, posed on the GPU. They share the layer's dynamic set with
  // the circling stones, so the crowd draws into a collecting copy of the layer and the page
  // commits both together.
  const ratBase = rats.map((e, i) => layer.palettes.of(`rat${i}`, e.model.roles));
  let ratList: readonly InstancePlacement[] = [];
  const ratLayer: InstanceLayer = { ...layer, setDynamic(l) { ratList = l; }, commit() {} };
  const crowd = makeCrowd({ instances: ratLayer, rigged: true, near: m(1000), freeze: m(1000) });
  const RAT_COUNT = 6;
  const members: CrowdMember[] = Array.from({ length: RAT_COUNT }, (_, i) => {
    const k = i % rats.length;
    const anim = makeAnimator(rats[k], i % 3 === 2 ? "run" : "walk");
    anim.update(i * 0.37);
    return { id: i + 1, entity: rats[k], variant: `rat${k}`, anim, base: ratBase[k], x: 0, y: 0, z: 0, yaw: 0 };
  });
  const stone = fine.get(KINDS.stone.key)!.model;
  const stoneBase = baseOf(KINDS.stone.key);

  t = performance.now();
  layer.setStatic(statics);
  const stoneId = layer.models.id(stone);
  load.upload = performance.now() - t;

  // --- the ground, all of it, then the boulders stamped into it ----------------------------------
  t = performance.now();
  const CHUNK = 256;
  const world = makeChunkedWorld({
    target: renderer,
    size: SIZE,
    chunk: CHUNK,
    seed,
    load: tracker,
    generate(ctx) {
      const boxes = [];
      for (let oz = ctx.box.z0; oz <= ctx.box.z1; oz += 8)
        for (let ox = ctx.box.x0; ox <= ctx.box.x1; ox += 8) {
          const [y0, y1] = ground.columnSpan(ox, oz);
          boxes.push({ x0: ox, y0, z0: oz, x1: ox + 7, y1, z1: oz + 7 });
        }
      renderer.editMany(boxes, (cells, ox, oy, oz) => ground.fillBrick(cells, ox, oy, oz, groundBase));
    },
  });
  world.focus(SIZE.x / 2, SIZE.z / 2, m(32), m(40));
  while (world.pending) {
    world.step(40);
    await nextFrame();
  }
  const BOULDERS: [number, number, number][] = [[21, 5, 0], [34, 4, 1], [36, 17, 2], [19, 13, 1], [7, 7, 0], [14, 3, 2]];
  for (const [x, z, k] of BOULDERS) stamp(fine.get(KINDS.rocks[k].key)!.model, m(x), floor(m(x), m(z)) + 1, m(z), rockBase[k]);
  load.ground = performance.now() - t;

  /**
   * Write a model's voxels into the world at `(x, y, z)` (its anchor), unturned, over what is
   * there: one edit per world brick it touches. Works on sparse models (the engine's
   * blitModelToBricks reads dense data only).
   */
  function stamp(model: EntityModel, x: number, y: number, z: number, base: number): void {
    const ox = Math.round(x - model.anchor[0]), oy = Math.round(y - model.anchor[1]), oz = Math.round(z - model.anchor[2]);
    const buckets = new Map<number, number[]>();
    const key = (bx: number, by: number, bz: number) => bx + by * 1024 + bz * 1048576;
    const put = (mx: number, my: number, mz: number, v: number) => {
      const X = ox + mx, Y = oy + my, Z = oz + mz;
      if (X < 0 || Y < 0 || Z < 0 || X >= SIZE.x || Y >= SIZE.y || Z >= SIZE.z) return;
      const k = key(X >> 3, Y >> 3, Z >> 3);
      let list = buckets.get(k);
      if (!list) buckets.set(k, (list = []));
      list.push((X & 7) + (Y & 7) * 8 + (Z & 7) * 64, base + v - 1);
    };
    const { x: sx, y: sy, z: sz } = model.size;
    if (model.sparse) {
      const [dx, dy] = sparseDims(model.size);
      for (const [b, cells] of model.sparse.bricks) {
        const bx = (b % dx) * 8, by = (Math.floor(b / dx) % dy) * 8, bz = Math.floor(b / (dx * dy)) * 8;
        for (let i = 0; i < 512; i++) if (cells[i]) put(bx + (i & 7), by + ((i >> 3) & 7), bz + (i >> 6), cells[i]);
      }
    } else {
      for (let mz = 0; mz < sz; mz++) for (let my = 0; my < sy; my++) for (let mx = 0; mx < sx; mx++) {
        const v = model.data[mx + my * sx + mz * sx * sy];
        if (v) put(mx, my, mz, v);
      }
    }
    const boxes = [...buckets.keys()].map((k) => {
      const bx = (k % 1024) * 8, by = (Math.floor(k / 1024) % 1024) * 8, bz = Math.floor(k / 1048576) * 8;
      return { x0: bx, y0: by, z0: bz, x1: bx + 7, y1: by + 7, z1: bz + 7 };
    });
    renderer.editMany(boxes, (cells, bx, by, bz) => {
      const list = buckets.get(key(bx >> 3, by >> 3, bz >> 3));
      if (!list) return false;
      for (let i = 0; i < list.length; i += 2) cells[list[i]] = list[i + 1];
      return true;
    });
  }

  // --- what moves: stones round the pond, rats in a circle -----------------------------------------
  const [px, pz] = [m(POND.x), m(POND.z)];
  const movers = (time: number): InstancePlacement[] =>
    Array.from({ length: 4 }, (_, i) => {
      const a = (i / 4) * Math.PI * 2 + time * 0.3;
      const x = px + Math.sin(a) * m(POND.r + 0.6), z = pz + Math.cos(a) * m(POND.r + 0.6);
      return { model: stoneId, x, y: floor(x, z) + 1, z, anchor: stone.anchor, yaw: -a * 2.5, base: stoneBase };
    });
  const [rx, rz] = [m(RATS_AT.x), m(RATS_AT.z)];
  const walk = (time: number) => {
    members.forEach((r, i) => {
      // Counter-clockwise seen from above, facing along the circle.
      const a = (i / RAT_COUNT) * Math.PI * 2 + time * 0.35;
      r.x = rx + Math.sin(a) * m(RATS_AT.r);
      r.z = rz + Math.cos(a) * m(RATS_AT.r);
      r.y = floor(r.x, r.z) + 1;
      r.yaw = Math.atan2(Math.cos(a), -Math.sin(a));
    });
  };

  // --- lights ------------------------------------------------------------------------------------------
  const hy = floor(m(HOUSE.x), m(HOUSE.z));
  const lantern: Vec3 = [m(HOUSE.x) + Math.sin(HOUSE_YAW) * m(4.2), hy + m(1.8), m(HOUSE.z) + Math.cos(HOUSE_YAW) * m(4.2)];
  const woodLamp: Vec3 = [m(11), floor(m(11), m(26)) + m(2.4), m(26)];
  const small = (x: number, z: number, h: number, color: Vec3): PointLight => ({ position: [m(x), floor(m(x), m(z)) + m(h), m(z)], color, intensity: 0.9, range: m(3), shadows: false, glow: m(0.04) });
  renderer.setLights([
    { position: lantern, color: [1.0, 0.66, 0.34], intensity: 2.4, range: m(10), glow: m(0.12) },
    { position: woodLamp, color: [1.0, 0.74, 0.45], intensity: 2.0, range: m(9), glow: m(0.1) },
    small(POND.x - 3.5, POND.z + 2.5, 0.6, [0.78, 1.0, 0.36]),
    small(POND.x + 3.8, POND.z - 1.5, 0.5, [0.6, 0.8, 1.0]),
    small(8, 29, 1.2, [0.78, 1.0, 0.36]),
    small(15, 31, 0.9, [1.0, 0.5, 0.3]),
  ]);

  // --- the four views ----------------------------------------------------------------------------------
  /** From an eye (metres, and height above the ground) towards a point, as yaw/pitch in degrees. */
  const lookFrom = (ex: number, ez: number, eh: number, tx: number, tz: number, pitch: number) => {
    const eye: Vec3 = [m(ex), floor(m(ex), m(ez)) + m(eh), m(ez)];
    return { eye, yaw: (Math.atan2(tx - ex, tz - ez) * 180) / Math.PI, pitch };
  };
  const CAMERAS = [
    lookFrom(EYE0.x, EYE0.z, 1.65, 15, 32, 4), // inside the wood, towards its heart
    lookFrom(3, 3, 2.2, 30, 20, -2), // across the open ground: boulders, the pond, the cottage
    lookFrom(19.5, 10, 1.6, 29, 19, 1), // close on the pond, the stones, the rats and the cottage
    lookFrom(31, 37, 1.4, 14, 27, 28), // up past the wood's edge into the sky
  ];

  // --- frame ---------------------------------------------------------------------------------------------
  const atm = atmosphereFrame(timeOfDay(0.72), ATMOSPHERES.clear, { voxelsPerMetre: VPM });
  const fog = { density: 0.5 / m(30), color: atm.skyHorizon, heightFalloff: 0, distance: m(32) };
  let viewCap: number | null = null;
  const STEP = 1 / 60;
  let tick = 0;
  let drawn = 0;
  const waiting: { at: number; resolve: () => void }[] = [];
  const stamps: number[] = [];
  let t0 = performance.now();
  let frozen = false;
  let frozenAt = 0;
  const simTime = (now: number) => (ANIM ? (now - t0) / 1000 : tick * STEP);
  const advance = (time: number, dt: number) => {
    walk(time);
    for (const r of members) r.anim.update(dt);
  };

  t = performance.now();
  advance(0, 0);
  crowd.update(members, CAMERAS[view].eye as [number, number, number]);
  layer.setDynamic([...ratList, ...movers(0)]);
  layer.commit();
  load.place = performance.now() - t;

  // deferPipelines above: compile every variant the views draw (instances, the rats posed on the
  // GPU) before the first frame, timed on its own rather than inside the first frame. After the
  // placement, not beside it, so neither timing includes the other.
  t = performance.now();
  await prepared(renderer.prepare({ instances: true, parts: true }));
  load.pipelines = performance.now() - t;

  let lastTime = 0;
  const loop = runLoop((now) => {
    const cam = CAMERAS[view];
    // Frozen: draw the held state at the held time (the tick does not move either).
    const time = frozen ? lastTime : simTime(now);
    if (!frozen) {
      advance(time, ANIM ? Math.min(0.05, time - lastTime) : STEP);
      lastTime = time;
      crowd.update(members, cam.eye as [number, number, number]);
      layer.setDynamic([...ratList, ...movers(time)]);
      layer.commit();
    }
    gpu.renderScale = RENDER_SCALE;
    resizeToDisplay(gpu);
    renderer.render({ ...firstPersonFrame(cam.eye, cam.yaw, cam.pitch, 68), ...atm, fog: viewCap === null ? fog : { ...fog, distance: Math.min(fog.distance, viewCap) }, time });
    if (!frozen) tick++;
    drawn++;
    stamps.push(now);
    while (stamps.length && now - stamps[0] > 1000) stamps.shift();
    if (drawn === 1) load.total = performance.now() - tStart;
    for (let i = waiting.length - 1; i >= 0; i--)
      if (drawn >= waiting[i].at) {
        const { resolve } = waiting[i];
        waiting.splice(i, 1);
        gpu.device.queue.onSubmittedWorkDone().then(resolve);
      }
  }, true);
  observeResize(canvas, loop);
  screen.ready();
  markFrames(tracker, renderer);
  void reportLoadTimeline(tracker, { perf: false });

  const fps = () => (stamps.length > 1 ? ((stamps.length - 1) * 1000) / (stamps[stamps.length - 1] - stamps[0]) : 0);
  const gpuMs = () => {
    const g = renderer.gpuTimings();
    return g ? Object.values(g).reduce((a, b) => a + b, 0) : NaN;
  };
  const report = () => {
    const g = gpuMs();
    info.textContent = `${VPM} vox/m · view ${view}${params.get("view") === "all" ? " (all)" : ""} · ${PRESET} · ${Number.isFinite(g) ? `${g.toFixed(2)} ms GPU` : "no GPU timings"} · ${fps().toFixed(0)} fps`;
  };
  setInterval(report, 1000);
  report();

  if (params.has("e2e")) {
    Object.assign(window, {
      bench: {
        ready: () => drawn > 0,
        setView(i?: number) {
          view = i === undefined ? (view + 1) % VIEWS : Math.max(0, Math.min(VIEWS - 1, Math.round(i)));
          report();
          loop.invalidate();
        },
        frames: (n: number) => new Promise<void>((resolve) => waiting.push({ at: drawn + Math.max(1, Math.round(n)), resolve })),
        stats: () => {
          const st = renderer.instanceStats();
          return {
            vpm: VPM, view, fps: fps(), gpuMs: renderer.gpuTimings(), width: gpu.width, height: gpu.height,
            models: st.models, instances: st.instances, loadMs: { ...load },
          };
        },
        setDebug(v: number) { renderer.setDebug(v); loop.invalidate(); },
        setQuality(patch: Partial<RenderQuality> | null) { renderer.setQuality(patch ?? START_QUALITY); loop.invalidate(); },
        setViewDistance(voxels: number | null) {
          viewCap = voxels === null || !Number.isFinite(voxels) ? null : Math.max(1, voxels);
          loop.invalidate();
        },
        freeze(on: boolean) {
          if (on === frozen) return;
          frozen = on;
          // With ?anim=1 the clock runs on; skip the time spent frozen so motion resumes in place.
          if (on) frozenAt = performance.now();
          else t0 += performance.now() - frozenAt;
          loop.invalidate();
        },
      },
    });
  }
}
