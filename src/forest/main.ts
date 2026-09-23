// forest — a scene built entirely from entity generators.
//
// Nothing here is authored by hand. A heightmap makes the ground, then trees,
// shrubs and ground cover are generated at runtime and stamped into one voxel
// grid. It is the clearest demonstration of what the entity contract buys:
// three independent generator packages, each emitting colour *roles* rather
// than colours, all sharing the renderer's single 256-slot palette because a
// PaletteAllocator hands each species its own range.
//
// The forest populates one entity at a time, uploading only the box each
// entity touched, so the page stays responsive and you watch it grow.

import {
  createRenderer,
  makeCamera,
  makePerf,
  observeResize,
  QUALITY_PRESETS,
  resizeToDisplay,
  type Renderer,
  type Vec3,
} from "@voxolith/renderer";
import { seededRandom, hashSeed } from "@voxolith/renderer/core";
import {
  makeChunkedWorld,
  makeVariantPool,
  scatterRegion,
  PaletteAllocator,
  voxelCount,
  type Entity,
  type Role,
  type VariantPool,
} from "@voxolith/engine";
import { makeNoise } from "@voxolith/gen-kit";
import { makeGeneratorPool } from "@voxolith/engine/worker";
import { createInput, makeOrbitController, prepareSurface } from "@voxolith/engine/input";
import { generateTree, PRESETS as TREES } from "@voxolith/gen-tree";
import { generateBush, PRESETS as BUSHES } from "@voxolith/gen-bush";
import { generateGrass, PRESETS as GRASSES } from "@voxolith/gen-grass";
import { boot, runLoop } from "../shared/boot";
import { DAYLIGHT } from "../shared/env";

// One tile is the original 320-voxel-square footprint. `scale` lays out a
// SPANxSPAN block of them at the same voxel resolution, so scale=4 is sixteen
// times the ground: 1280x176x1280, a 288 MB r8uint texture. Entity counts and
// the camera distance follow it, so the forest reads the same at any size.
const params = new URLSearchParams(location.search);
const SPAN = Math.max(1, Math.min(8, Math.round(Number(params.get("scale") ?? 4))));
const TILE = 320;
const SIZE = { x: TILE * SPAN, y: 176, z: TILE * SPAN };

const seed = hashSeed(params.get("seed") ?? "voxolith");
const season = (params.get("season") ?? "summer") as "spring" | "summer" | "autumn" | "winter";
// Keeping the species list short keeps the palette comfortable: each species
// and season combination takes its own slot range.
const TREE_KINDS = ["oak", "birch", "spruce"] as const;
const BUSH_KINDS = ["bush", "bramble"] as const;
const GRASS_KINDS = ["grass", "meadow", "fern"] as const;

const app = await boot("forest");
if (app) {
  const { gpu, canvas, info } = app;
  const noise = makeNoise(seed);

  // --- ground ---------------------------------------------------------------
  // No dense voxel array anywhere: the world is written straight into brick
  // storage. A dense mirror of an 8x8 forest would be 1.1 GB of Uint8Array for a
  // world the GPU holds sparsely in ~160 MB.
  const palette = new PaletteAllocator(1);
  const ground: Role[] = [
    { id: "ground.grass", name: "Turf", color: [0.29, 0.42, 0.21] },
    { id: "ground.grass2", name: "Turf light", color: [0.35, 0.48, 0.24] },
    { id: "ground.dirt", name: "Soil", color: [0.31, 0.24, 0.17] },
    { id: "ground.rock", name: "Rock", color: [0.42, 0.41, 0.39] },
  ];
  const { base: groundBase } = palette.allocate(ground, "ground");
  const TURF = groundBase, TURF2 = groundBase + 1, SOIL = groundBase + 2, ROCK = groundBase + 3;

  // Gentle undulation, so trees sit at different heights without the ground
  // ever getting steep enough to leave a trunk hanging in the air.
  const BASE_Y = 10;
  const height = new Int16Array(SIZE.x * SIZE.z);
  for (let z = 0; z < SIZE.z; z++)
    for (let x = 0; x < SIZE.x; x++) {
      const h =
        BASE_Y +
        Math.round(noise.fbm2(x * 0.012, z * 0.012, 3) * 14 - 5) +
        Math.round(noise.fbm2(x * 0.05, z * 0.05, 2) * 3);
      height[x + z * SIZE.x] = Math.max(3, h);
    }
  let maxH = 0;
  for (let i = 0; i < height.length; i++) if (height[i] > maxH) maxH = height[i];

  const renderer: Renderer = await createRenderer(gpu, { size: SIZE, palette: palette.buildPalette() });

  renderer.setClipBounds([0, 0, 0], [SIZE.x - 1, SIZE.y - 1, SIZE.z - 1]);
  const quality = gpu.software ? "low" : "medium";
  // A ray that runs out of steps returns "no hit" and shades as sky, so the cap
  // is a correctness backstop, not a quality knob. Coarse skipping keeps the
  // real cost low even here — measured worst case over this scene is ~510 steps
  // at scale=4, from a camera down inside the canopy — but the budget scales
  // with the world for headroom. Over-provisioning is free: rays that terminate
  // early still terminate early.
  renderer.setQuality({
    ...QUALITY_PRESETS[quality],
    maxSteps: Math.min(4096, QUALITY_PRESETS[quality].maxSteps * SPAN),
  });

  // --- camera ---------------------------------------------------------------
  const target: Vec3 = [SIZE.x / 2, BASE_Y + 46, SIZE.z / 2];
  const far = 430 * SPAN;
  const camera = makeCamera({ target, distance: far, pitchDeg: 20, fovDeg: 42 });
  // Drag to turn, wheel or pinch to zoom. Every input event requests a frame.
  prepareSurface(canvas);
  const input = createInput(canvas, { loop: { invalidate: () => loop.invalidate() } });
  const orbit = makeOrbitController(input, {
    yaw: 35, pitch: 20, pitchLimits: [6, 80], distance: far, distanceLimits: [140, far * 1.7], fovDeg: 42,
  });

  // Frame cadence + adaptive render scale, the same knob the other apps use.
  // ?perf=1 shows the overlay; the controller runs either way, so a slow
  // machine drops resolution instead of the frame rate.
  const adapter = gpu.adapterInfo;
  const perf = makePerf({
    enabled: params.has("perf"),
    scale: gpu.renderScale,
    minScale: gpu.software ? 0.25 : 0.35,
    // The forest renders continuously and a big one can take well over 250 ms
    // a frame; without this the default gap filter discards every sample and
    // the overlay cheerfully reports 60 fps while the scale never adapts.
    maxSampleMs: 4000,
    label:
      ([adapter.vendor, adapter.architecture, adapter.description].filter(Boolean).join(" · ") || "unknown adapter") +
      `${gpu.software ? " (software)" : ""} · quality ${quality}`,
  });

  let spin = true;
  /** Set once the chunked world exists; see below. */
  let streamWorld: (() => void) | null = null;
  const loop = runLoop((now, dt) => {
    streamWorld?.();
    perf.frame(now);
    gpu.renderScale = perf.scale();
    resizeToDisplay(gpu);
    // The idle turntable turns the controller itself, so stopping it never jumps.
    if (spin) orbit.set({ yaw: orbit.yaw() + dt * 3.85 });
    renderer.render({ ...camera(orbit.yaw(), orbit.distance(), target, orbit.pitch()), ...DAYLIGHT });
  }, true);
  observeResize(canvas, loop);
  // Any touch stops the slow turntable.
  input.on((e) => {
    if (e.kind !== "pointer" || e.phase !== "down" || !spin) return;
    spin = false;
    loop.setContinuous(false);
  });

  // Generating a unique model per plant is what makes a big forest slow to
  // build: measured at 4x4 it was 90% of the total. A pool generates a dozen per
  // species and places them in any of 8 axis-aligned orientations, so thousands
  // of plants cost ~96 generations and still show ~96 silhouettes each.
  //
  // Those generations happen on a worker pool, in parallel and off the render
  // thread, so the turntable keeps turning while the models are built.
  const VARIANTS = Math.max(1, Number(params.get("variants") ?? 12));
  const useWorkers = params.get("workers") !== "0";

  interface Species {
    key: string;
    /** Registry id, for the worker path. */
    generator: string;
    /** Parameters for variant `n`. One definition, used by both paths. */
    params: (n: number) => unknown;
    /** Main-thread fallback, when workers are unavailable. */
    make: (n: number) => Entity;
  }

  const species: Species[] = [
    ...TREE_KINDS.map((kind): Species => {
      const at = (n: number) => {
        const p = structuredClone(TREES[kind]);
        p.shape.height = Math.round(84 + (n / VARIANTS) * 40);
        p.look.season = season;
        p.look.age = 0.35 + (n / VARIANTS) * 0.6;
        return p;
      };
      return {
        key: `tree:${kind}:${season}`,
        generator: kind === "spruce" ? "voxolith/tree.conifer" : "voxolith/tree.broadleaf",
        params: at,
        make: (n) => generateTree(at(n), seededRandom(seed + n * 977)).entity,
      };
    }),
    ...BUSH_KINDS.map((kind): Species => {
      const at = (n: number) => {
        const p = structuredClone(BUSHES[kind]);
        p.shape.height = Math.round(28 + (n / VARIANTS) * 22);
        p.look.season = season;
        return p;
      };
      return {
        key: `bush:${kind}:${season}`,
        generator: "voxolith/bush",
        params: at,
        make: (n) => generateBush(at(n), seededRandom(seed + 5000 + n * 131)).entity,
      };
    }),
    ...GRASS_KINDS.map((kind): Species => {
      const at = (n: number) => {
        const p = structuredClone(GRASSES[kind]);
        p.shape.height = Math.round(16 + (n / VARIANTS) * 14);
        p.look.season = season;
        return p;
      };
      return {
        key: `grass:${kind}:${season}`,
        generator: "voxolith/grass",
        params: at,
        make: (n) => generateGrass(at(n), seededRandom(seed + 9000 + n * 71)).entity,
      };
    }),
  ];

  const pools = new Map<string, VariantPool>();

  /** Build every variant, on workers when available. Returns models generated. */
  async function buildPools(): Promise<number> {
    const report = (done: number, total: number) => {
      info.textContent = `generating ${done}/${total} models`;
    };
    if (useWorkers && typeof Worker !== "undefined") {
      const workers = makeGeneratorPool({
        spawn: () => new Worker(new URL("./gen.worker.ts", import.meta.url), { type: "module" }),
      });
      try {
        await workers.ready();
        const specs = species.flatMap((sp, si) =>
          Array.from({ length: VARIANTS }, (_, n) => ({
            generator: sp.generator,
            params: sp.params(n),
            seed: seed + si * 7919 + n * 977,
            entityId: `${sp.key}-${n}`,
          })),
        );
        const models = await workers.generateMany(specs, report);
        species.forEach((sp, si) => {
          const mine = models.slice(si * VARIANTS, (si + 1) * VARIANTS);
          pools.set(sp.key, makeVariantPool({ count: mine.length, make: (i) => mine[i] }));
        });
        return models.length;
      } catch (err) {
        // A blocked or unsupported worker should degrade, not break the page.
        console.warn("[forest] worker generation failed, falling back to the main thread:", err);
      } finally {
        workers.destroy();
      }
    }
    let done = 0;
    for (const sp of species) {
      const mine = Array.from({ length: VARIANTS }, (_, n) => {
        const e = sp.make(n);
        report(++done, species.length * VARIANTS);
        return e;
      });
      pools.set(sp.key, makeVariantPool({ count: mine.length, make: (i) => mine[i] }));
    }
    return done;
  }

  // voxelCount is a full scan, so count each model once however often it lands.
  const counted = new Map<Entity, number>();
  const sizeOf = (e: Entity): number => {
    let n = counted.get(e);
    if (n === undefined) {
      n = voxelCount(e.model);
      counted.set(e, n);
    }
    return n;
  };

  // Growing one entity per frame would be needlessly slow on a fast machine and
  // needlessly janky on a slow one, so yield on a time budget instead: plant as
  // many entities as fit in a frame, then hand the thread back to paint one.
  // `grow=0` plants everything in one go, for screenshots and benchmarks.
  const incremental = params.get("grow") !== "0";
  let lastYield = performance.now();
  const breathe = async (force = false): Promise<void> => {
    if (!force && (!incremental || performance.now() - lastYield < 16)) return;
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    lastYield = performance.now();
  };
  const t0 = performance.now();
  const modelCount = await buildPools();
  const tModels = performance.now() - t0;
  // --- the world ------------------------------------------------------------
  // Built a chunk at a time around the camera rather than all at once, so what
  // exists is bounded by the view and not by the size of the world.
  //
  // That makes generation order-dependent unless it is a pure function of
  // position, because chunks are built in whatever order the camera reaches
  // them. Entities come from a jittered grid (scatterRegion) that any chunk can
  // evaluate for itself and for its neighbours, and each chunk draws everything
  // reaching into it clipped to its own bounds — so a tree straddling a
  // boundary is identical whichever side was built first.
  const CHUNK = 64;
  /** Cell size per layer, picked to land near the old per-tile entity counts. */
  const LAYERS = [
    { key: "tree", kinds: TREE_KINDS, cell: 90, salt: 1, margin: 80, chance: 0.92 },
    { key: "bush", kinds: BUSH_KINDS, cell: 68, salt: 2, margin: 36, chance: 0.9 },
    { key: "grass", kinds: GRASS_KINDS, cell: 55, salt: 3, margin: 24, chance: 0.9 },
  ] as const;

  let voxels = 0;
  let placed = 0;
  let lastPaletteSize = -1;

  const world = makeChunkedWorld({
    target: renderer,
    size: SIZE,
    chunk: CHUNK,
    seed,
    generate(ctx) {
      ctx.edit({ ...ctx.box, y1: maxH }, (cells, ox, oy, oz) => {
        let touched = false;
        for (let lz = 0; lz < 8; lz++) {
          const wz = oz + lz;
          if (wz >= SIZE.z) break;
          for (let lx = 0; lx < 8; lx++) {
            const wx = ox + lx;
            if (wx >= SIZE.x) break;
            const h = height[wx + wz * SIZE.x];
            const top = Math.min(h, oy + 7);
            for (let wy = oy; wy <= top; wy++) {
              cells[lx + (wy - oy) * 8 + lz * 64] =
                wy === h ? (noise.value2(wx * 0.3, wz * 0.3) > 0.5 ? TURF : TURF2) : wy > h - 3 ? SOIL : ROCK;
              touched = true;
            }
          }
        }
        return touched;
      });

      for (const layer of LAYERS) {
        scatterRegion(
          { cell: layer.cell, seed, salt: layer.salt },
          ctx.box.x0 - layer.margin, ctx.box.z0 - layer.margin,
          ctx.box.x1 + layer.margin, ctx.box.z1 + layer.margin,
          (pt) => {
            if (pt.x < 0 || pt.z < 0 || pt.x >= SIZE.x || pt.z >= SIZE.z) return;
            if (pt.rng() > layer.chance) return;
            const kind = layer.kinds[Math.min(layer.kinds.length - 1, (pt.rng() * layer.kinds.length) | 0)];
            const key = `${layer.key}:${kind}:${season}`;
            const v = pools.get(key)!.at((pt.rng() * 1e6) | 0, pt.rng);
            const { base } = palette.allocateFor(v.entity, key);
            if (palette.used !== lastPaletteSize) {
              lastPaletteSize = palette.used;
              renderer.updatePalette(palette.buildPalette());
            }
            ctx.blit(v.entity.model, { x: pt.x, y: height[pt.x + pt.z * SIZE.x] + 1, z: pt.z }, base, v.orientation);
            // A straddling entity is offered to every chunk it can reach, so
            // count it once — for the chunk that owns its root.
            if (pt.x >= ctx.box.x0 && pt.x <= ctx.box.x1 && pt.z >= ctx.box.z0 && pt.z <= ctx.box.z1) {
              placed++;
              voxels += sizeOf(v.entity);
            }
          },
        );
      }
    },
  });

  // How much world to keep resident. Defaults to all of it, so the demo still
  // shows a whole forest; lower it to watch residency work.
  const RADIUS = Number(params.get("radius") ?? SIZE.x * 1.5);
  world.focus(SIZE.x / 2, SIZE.z / 2, RADIUS);
  const totalChunks = world.pending;

  while (world.pending) {
    const left = world.step(12);
    info.textContent = `building ${totalChunks - left}/${totalChunks} chunks`;
    loop.invalidate();
    await breathe(true);
  }

  // Keep the world following the view. Nothing moves the target in this demo,
  // so this is idle here — but it is what makes the residency real rather than
  // a one-shot: pan or walk and the world follows, at a bounded cost.
  let focusX = target[0];
  let focusZ = target[2];
  streamWorld = () => {
    if (Math.abs(target[0] - focusX) < CHUNK / 2 && Math.abs(target[2] - focusZ) < CHUNK / 2) {
      if (world.pending) world.step(4);
      return;
    }
    focusX = target[0];
    focusZ = target[2];
    world.focus(focusX, focusZ, RADIUS);
    world.step(4);
  };

  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  const mem = renderer.stats();
  info.textContent =
    `${placed} plants from ${modelCount} models in ${world.resident} chunks ` +
    `(${(tModels / 1000).toFixed(1)}s gen, ${((performance.now() - t0 - tModels) / 1000).toFixed(1)}s plant) · ` +
    `${(voxels / 1000).toFixed(0)}k voxels · ${palette.used}/255 palette slots · ` +
    `${(mem.bytes / 1048576).toFixed(0)} MB of bricks (dense would be ${(mem.dense / 1048576).toFixed(0)} MB) · ` +
    `grown in ${secs}s` +
    ` · drag to orbit, wheel to zoom`;
  loop.invalidate();
}
