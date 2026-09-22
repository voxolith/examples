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
  makeOrbitControl,
  makePerf,
  observeResize,
  QUALITY_PRESETS,
  resizeToDisplay,
  type Renderer,
  type Vec3,
} from "@voxolith/renderer";
import { seededRandom, hashSeed } from "@voxolith/renderer/core";
import {
  blitModel,
  makeVariantPool,
  PaletteAllocator,
  voxelCount,
  type Entity,
  type Orientation,
  type Role,
  type VariantPool,
} from "@voxolith/engine";
import { makeNoise } from "@voxolith/engine/build";
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
const AREA = SPAN * SPAN;
const SIZE = { x: TILE * SPAN, y: 176, z: TILE * SPAN };
const idx = (x: number, y: number, z: number) => x + y * SIZE.x + z * SIZE.x * SIZE.y;

const seed = hashSeed(params.get("seed") ?? "voxolith");
const season = (params.get("season") ?? "summer") as "spring" | "summer" | "autumn" | "winter";
// Keeping the species list short keeps the palette comfortable: each species
// and season combination takes its own slot range.
const TREE_KINDS = ["oak", "birch", "spruce"] as const;
const BUSH_KINDS = ["bush", "bramble"] as const;
const GRASS_KINDS = ["grass", "meadow", "fern"] as const;
const COUNTS = {
  trees: Number(params.get("trees") ?? 14 * AREA),
  bushes: Number(params.get("bushes") ?? 22 * AREA),
  grass: Number(params.get("grass") ?? 34 * AREA),
};

const app = await boot("forest");
if (app) {
  const { gpu, canvas, info } = app;
  const rng = seededRandom(seed);
  const noise = makeNoise(seed);

  // --- ground ---------------------------------------------------------------
  const world = new Uint8Array(SIZE.x * SIZE.y * SIZE.z);
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
  for (let z = 0; z < SIZE.z; z++)
    for (let x = 0; x < SIZE.x; x++) {
      const h = height[x + z * SIZE.x];
      for (let y = 0; y <= h; y++) {
        world[idx(x, y, z)] =
          y === h ? (noise.value2(x * 0.3, z * 0.3) > 0.5 ? TURF : TURF2) : y > h - 3 ? SOIL : ROCK;
      }
    }

  const renderer: Renderer = await createRenderer(gpu, { size: SIZE, data: world, palette: palette.buildPalette() });
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
  let distance = far;
  const orbit = makeOrbitControl(canvas, {
    start: 35,
    min: -Infinity,
    max: Infinity,
    onChange: () => loop.invalidate(),
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      distance = Math.max(140, Math.min(far * 1.7, distance * (1 + Math.sign(e.deltaY) * 0.1)));
      loop.invalidate();
    },
    { passive: false },
  );

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
  const loop = runLoop((now) => {
    perf.frame(now);
    gpu.renderScale = perf.scale();
    resizeToDisplay(gpu);
    const yaw = orbit.yaw() + (spin ? now / 260 : 0);
    renderer.render({ ...camera(yaw, distance, target), ...DAYLIGHT });
  }, true);
  observeResize(canvas, loop);
  canvas.addEventListener("pointerdown", () => {
    // Any interaction stops the slow turntable.
    spin = false;
    loop.setContinuous(false);
  });

  // --- planting -------------------------------------------------------------
  interface Planted {
    x: number;
    z: number;
    r: number;
  }
  // Plants are bucketed into a coarse grid so a candidate only tests its own
  // cell and the eight around it. Scanning every plant placed so far is fine
  // for a single tile but quadratic, and a 4x4 forest plants over a thousand.
  const CELL = 64; // > the largest clearance below, so 3x3 cells always suffice
  const gw = Math.ceil(SIZE.x / CELL);
  const gd = Math.ceil(SIZE.z / CELL);
  const buckets: Planted[][] = Array.from({ length: gw * gd }, () => []);
  const bucketAt = (x: number, z: number) =>
    buckets[Math.min(gw - 1, (x / CELL) | 0) + Math.min(gd - 1, (z / CELL) | 0) * gw];

  /**
   * Reject a spot that crowds anything already planted. The clearance between
   * two plants is the *larger* of their radii, not the sum: a forest wants its
   * canopies touching, and summing would push every shrub a full tree-radius
   * clear of a tree that is itself a full tree-radius from its neighbour,
   * leaving nowhere for the undergrowth to go.
   */
  function findSpot(radius: number, margin: number, tries = 120): Planted | null {
    for (let t = 0; t < tries; t++) {
      const x = Math.round(margin + rng() * (SIZE.x - margin * 2));
      const z = Math.round(margin + rng() * (SIZE.z - margin * 2));
      const cx = Math.min(gw - 1, (x / CELL) | 0);
      const cz = Math.min(gd - 1, (z / CELL) | 0);
      let ok = true;
      for (let j = Math.max(0, cz - 1); j <= Math.min(gd - 1, cz + 1) && ok; j++) {
        for (let i = Math.max(0, cx - 1); i <= Math.min(gw - 1, cx + 1) && ok; i++) {
          for (const p of buckets[i + j * gw]) {
            const clear = Math.max(p.r, radius);
            if ((p.x - x) ** 2 + (p.z - z) ** 2 < clear * clear) { ok = false; break; }
          }
        }
      }
      if (ok) return { x, z, r: radius };
    }
    return null;
  }

  // Generating a unique model per plant is what makes a big forest slow to
  // build: measured at 4x4 it is 90% of the total. A pool generates a dozen per
  // species and places them in any of 8 axis-aligned orientations, so 1120
  // plants cost ~96 generations and still show ~96 distinct silhouettes each.
  const VARIANTS = Math.max(1, Number(params.get("variants") ?? 12));
  const pools = new Map<string, VariantPool>();
  const pool = (key: string, make: (i: number) => Entity): VariantPool => {
    let p = pools.get(key);
    if (!p) {
      p = makeVariantPool({ count: VARIANTS, make });
      pools.set(key, p);
    }
    return p;
  };

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

  function plant(entity: Entity, key: string, x: number, z: number, o: Orientation): void {
    const { base } = palette.allocateFor(entity, key);
    const y = height[x + z * SIZE.x] + 1;
    const box = blitModel({ size: SIZE, data: world }, entity.model, { x, y, z }, base, o);
    if (!box) return;
    // The palette only changes when a species is seen for the first time.
    if (palette.used !== lastPaletteSize) {
      lastPaletteSize = palette.used;
      renderer.updatePalette(palette.buildPalette());
    }
    renderer.updateVoxels(world, box);
  }
  let lastPaletteSize = -1;

  // Growing one entity per frame would be needlessly slow on a fast machine and
  // needlessly janky on a slow one, so yield on a time budget instead: plant as
  // many entities as fit in a frame, then hand the thread back to paint one.
  // `grow=0` plants everything in one go, for screenshots and benchmarks.
  const incremental = params.get("grow") !== "0";
  let lastYield = performance.now();
  const breathe = async (): Promise<void> => {
    if (!incremental || performance.now() - lastYield < 16) return;
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    lastYield = performance.now();
  };
  const t0 = performance.now();
  let voxels = 0;
  let planted = 0;
  const total = COUNTS.trees + COUNTS.bushes + COUNTS.grass;
  const progress = (label: string) => {
    info.textContent = `${label} · ${planted}/${total} · ${(voxels / 1000).toFixed(0)}k voxels`;
  };

  // Trees first and largest, so they claim their space before the undergrowth.
  for (let i = 0; i < COUNTS.trees; i++) {
    const kind = TREE_KINDS[Math.floor(rng() * TREE_KINDS.length)];
    const spot = findSpot(30, 40);
    if (!spot) continue;
    bucketAt(spot.x, spot.z).push(spot);
    const v = pool(`tree:${kind}`, (n) => {
      const p = structuredClone(TREES[kind]);
      // Vary the pool itself, so a dozen models are a dozen different trees.
      p.shape.height = Math.round(84 + (n / VARIANTS) * 40);
      p.look.season = season;
      p.look.age = 0.35 + (n / VARIANTS) * 0.6;
      return generateTree(p, seededRandom(seed + n * 977), `tree-${kind}-${n}`).entity;
    }).pick(rng);
    plant(v.entity, `tree:${kind}:${season}`, spot.x, spot.z, v.orientation);
    voxels += sizeOf(v.entity);
    planted++;
    progress("growing trees");
    await breathe();
  }

  for (let i = 0; i < COUNTS.bushes; i++) {
    const kind = BUSH_KINDS[Math.floor(rng() * BUSH_KINDS.length)];
    const spot = findSpot(16, 24);
    if (!spot) continue;
    bucketAt(spot.x, spot.z).push(spot);
    const v = pool(`bush:${kind}`, (n) => {
      const p = structuredClone(BUSHES[kind]);
      p.shape.height = Math.round(28 + (n / VARIANTS) * 22);
      p.look.season = season;
      return generateBush(p, seededRandom(seed + 5000 + n * 131), `bush-${kind}-${n}`).entity;
    }).pick(rng);
    plant(v.entity, `bush:${kind}:${season}`, spot.x, spot.z, v.orientation);
    voxels += sizeOf(v.entity);
    planted++;
    progress("planting shrubs");
    await breathe();
  }

  for (let i = 0; i < COUNTS.grass; i++) {
    const kind = GRASS_KINDS[Math.floor(rng() * GRASS_KINDS.length)];
    // Ground cover is allowed to crowd, so it only avoids other patches.
    const spot = findSpot(10, 14);
    if (!spot) continue;
    bucketAt(spot.x, spot.z).push(spot);
    const v = pool(`grass:${kind}`, (n) => {
      const p = structuredClone(GRASSES[kind]);
      p.shape.height = Math.round(16 + (n / VARIANTS) * 14);
      p.look.season = season;
      return generateGrass(p, seededRandom(seed + 9000 + n * 71), `grass-${kind}-${n}`).entity;
    }).pick(rng);
    plant(v.entity, `grass:${kind}:${season}`, spot.x, spot.z, v.orientation);
    voxels += sizeOf(v.entity);
    planted++;
    progress("scattering ground cover");
    await breathe();
  }

  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  info.textContent =
    `${planted} entities from ${[...pools.values()].reduce((a, p) => a + p.generated, 0)} models · ` +
    `${(voxels / 1000).toFixed(0)}k voxels · ${palette.used}/255 palette slots · grown in ${secs}s` +
    ` · drag to orbit, wheel to zoom`;
  loop.invalidate();
}
