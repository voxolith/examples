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
  observeResize,
  OccupancyGrid,
  QUALITY_PRESETS,
  resizeToDisplay,
  type Renderer,
  type Vec3,
} from "@voxolith/renderer";
import { seededRandom, hashSeed } from "@voxolith/renderer/core";
import { blitModel, PaletteAllocator, type Entity, type Role } from "@voxolith/engine";
import { makeNoise } from "@voxolith/engine/build";
import { generateTree, PRESETS as TREES } from "@voxolith/gen-tree";
import { generateBush, PRESETS as BUSHES } from "@voxolith/gen-bush";
import { generateGrass, PRESETS as GRASSES } from "@voxolith/gen-grass";
import { boot, runLoop } from "../shared/boot";
import { DAYLIGHT } from "../shared/env";

const SIZE = { x: 320, y: 176, z: 320 };
const idx = (x: number, y: number, z: number) => x + y * SIZE.x + z * SIZE.x * SIZE.y;

const params = new URLSearchParams(location.search);
const seed = hashSeed(params.get("seed") ?? "voxolith");
const season = (params.get("season") ?? "summer") as "spring" | "summer" | "autumn" | "winter";
// Keeping the species list short keeps the palette comfortable: each species
// and season combination takes its own slot range.
const TREE_KINDS = ["oak", "birch", "spruce"] as const;
const BUSH_KINDS = ["bush", "bramble"] as const;
const GRASS_KINDS = ["grass", "meadow", "fern"] as const;
const COUNTS = {
  trees: Number(params.get("trees") ?? 14),
  bushes: Number(params.get("bushes") ?? 22),
  grass: Number(params.get("grass") ?? 34),
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
  renderer.setQuality(QUALITY_PRESETS[gpu.software ? "low" : "medium"]);
  const occupancy = new OccupancyGrid(SIZE, world);
  renderer.updateCoarse(occupancy.data);

  // --- camera ---------------------------------------------------------------
  const target: Vec3 = [SIZE.x / 2, BASE_Y + 46, SIZE.z / 2];
  const camera = makeCamera({ target, distance: 430, pitchDeg: 20, fovDeg: 42 });
  let distance = 430;
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
      distance = Math.max(140, Math.min(700, distance * (1 + Math.sign(e.deltaY) * 0.1)));
      loop.invalidate();
    },
    { passive: false },
  );

  let spin = true;
  const loop = runLoop((now) => {
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
  const placed: Planted[] = [];
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
      let ok = true;
      for (const p of placed) {
        const clear = Math.max(p.r, radius);
        if ((p.x - x) ** 2 + (p.z - z) ** 2 < clear * clear) {
          ok = false;
          break;
        }
      }
      if (ok) return { x, z, r: radius };
    }
    return null;
  }

  function plant(entity: Entity, key: string, x: number, z: number): void {
    const { base } = palette.allocateFor(entity, key);
    const y = height[x + z * SIZE.x] + 1;
    const box = blitModel({ size: SIZE, data: world }, entity.model, { x, y, z }, base);
    if (!box) return;
    renderer.updatePalette(palette.buildPalette());
    renderer.updateVoxels(world, box);
    renderer.updateCoarse(occupancy.data, occupancy.updateBox(world, box));
  }

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
    placed.push(spot);
    const p = structuredClone(TREES[kind]);
    p.shape.height = Math.round(84 + rng() * 40);
    p.look.season = season;
    p.look.age = 0.35 + rng() * 0.6;
    const { entity, stats } = generateTree(p, seededRandom(seed + i * 977), `tree-${i}`);
    plant(entity, `tree:${kind}:${season}`, spot.x, spot.z);
    voxels += stats.total;
    planted++;
    progress("growing trees");
    await breathe();
  }

  for (let i = 0; i < COUNTS.bushes; i++) {
    const kind = BUSH_KINDS[Math.floor(rng() * BUSH_KINDS.length)];
    const spot = findSpot(16, 24);
    if (!spot) continue;
    placed.push(spot);
    const p = structuredClone(BUSHES[kind]);
    p.shape.height = Math.round(28 + rng() * 22);
    p.look.season = season;
    const { entity, stats } = generateBush(p, seededRandom(seed + 5000 + i * 131), `bush-${i}`);
    plant(entity, `bush:${kind}:${season}`, spot.x, spot.z);
    voxels += stats.total;
    planted++;
    progress("planting shrubs");
    await breathe();
  }

  for (let i = 0; i < COUNTS.grass; i++) {
    const kind = GRASS_KINDS[Math.floor(rng() * GRASS_KINDS.length)];
    // Ground cover is allowed to crowd, so it only avoids other patches.
    const spot = findSpot(10, 14);
    if (!spot) continue;
    placed.push(spot);
    const p = structuredClone(GRASSES[kind]);
    p.shape.height = Math.round(16 + rng() * 14);
    p.look.season = season;
    const { entity, stats } = generateGrass(p, seededRandom(seed + 9000 + i * 71), `grass-${i}`);
    plant(entity, `grass:${kind}:${season}`, spot.x, spot.z);
    voxels += stats.total;
    planted++;
    progress("scattering ground cover");
    await breathe();
  }

  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  info.textContent =
    `${planted} entities · ${(voxels / 1000).toFixed(0)}k voxels · ${palette.used}/255 palette slots · grown in ${secs}s` +
    ` · drag to orbit, wheel to zoom`;
  loop.invalidate();
}
