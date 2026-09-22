// village — houses, woods and stones, all from entity generators.
//
// The forest example's streamed world with a settlement in it. What a village
// adds over a forest is that entities have to agree with the ground and with
// each other: a house needs level ground, trees must keep clear of walls and
// paths, and doors should face somewhere worth walking to.
//
// All of that is settled once, up front and deterministically, before a single
// chunk is built: house sites, their orientation, a levelled pad under each,
// and the footpaths joining their doors. Chunks then only read those decisions,
// so the world stays a pure function of position and still streams in any
// order.

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
  makeChunkedWorld,
  makeVariantPool,
  orientAnchor,
  orientedSize,
  orientVoxel,
  scatterRegion,
  PaletteAllocator,
  voxelCount,
  type Entity,
  type Orientation,
  type Role,
  type VariantPool,
} from "@voxolith/engine";
import { makeNoise } from "@voxolith/gen-kit";
import { makeGeneratorPool } from "@voxolith/engine/worker";
import { generateTree, PRESETS as TREES } from "@voxolith/gen-tree";
import { generateBush, PRESETS as BUSHES } from "@voxolith/gen-bush";
import { generateGrass, PRESETS as GRASSES } from "@voxolith/gen-grass";
import { generateRock, PRESETS as ROCKS } from "@voxolith/gen-rock";
import { generateBuilding, PRESETS as BUILDINGS, type BuildingParams } from "@voxolith/gen-building";
import { boot, runLoop } from "../shared/boot";
import { DAYLIGHT } from "../shared/env";

// Same tiling as the forest: one tile is 320 voxels square, `scale` lays out a
// SPANxSPAN block. The village sits in the middle and scales with the world.
const params = new URLSearchParams(location.search);
const SPAN = Math.max(1, Math.min(8, Math.round(Number(params.get("scale") ?? 3))));
const TILE = 320;
const SIZE = { x: TILE * SPAN, y: 192, z: TILE * SPAN };
const CX = SIZE.x / 2, CZ = SIZE.z / 2;
/** Radius of the village core, where houses cluster and the woods thin out. */
const VILLAGE_R = Math.max(110, 150 * SPAN);

const seed = hashSeed(params.get("seed") ?? "voxolith");
const season = (params.get("season") ?? "summer") as "spring" | "summer" | "autumn" | "winter";
const TREE_KINDS = ["oak", "birch", "spruce"] as const;
const BUSH_KINDS = ["bush", "bramble"] as const;
const GRASS_KINDS = ["grass", "meadow", "fern"] as const;
const ROCK_KINDS = ["boulder", "mossy", "pebbles", "outcrop"] as const;
const HOUSE_KINDS = ["cottage", "farmhouse", "brick"] as const;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const app = await boot("village");
if (app) {
  const { gpu, canvas, info } = app;
  const noise = makeNoise(seed);

  // --- palette ----------------------------------------------------------------
  // Every species takes its own slot range. The budget is tight with houses in
  // it (each house style is 32 roles), which is why the species lists are short
  // and the three rock styles share one granite skin.
  const palette = new PaletteAllocator(1);
  const ground: Role[] = [
    { id: "ground.grass", name: "Turf", color: [0.29, 0.42, 0.21] },
    { id: "ground.grass2", name: "Turf light", color: [0.35, 0.48, 0.24] },
    { id: "ground.dirt", name: "Soil", color: [0.31, 0.24, 0.17] },
    { id: "ground.rock", name: "Rock", color: [0.42, 0.41, 0.39] },
    { id: "ground.path", name: "Path", color: [0.46, 0.38, 0.27] },
    { id: "ground.path2", name: "Path worn", color: [0.53, 0.46, 0.34] },
    { id: "ground.yard", name: "Trodden turf", color: [0.36, 0.42, 0.24] },
  ];
  const { base: g0 } = palette.allocate(ground, "ground");
  const TURF = g0, TURF2 = g0 + 1, SOIL = g0 + 2, ROCK = g0 + 3, PATH = g0 + 4, PATH2 = g0 + 5, YARD = g0 + 6;

  // --- height -------------------------------------------------------------------
  const BASE_Y = 12;
  const height = new Int16Array(SIZE.x * SIZE.z);
  for (let z = 0; z < SIZE.z; z++)
    for (let x = 0; x < SIZE.x; x++) {
      const h =
        BASE_Y +
        Math.round(noise.fbm2(x * 0.01, z * 0.01, 3) * 16 - 6) +
        Math.round(noise.fbm2(x * 0.05, z * 0.05, 2) * 3);
      height[x + z * SIZE.x] = Math.max(3, h);
    }

  const renderer: Renderer = await createRenderer(gpu, { size: SIZE, palette: palette.buildPalette() });
  renderer.setClipBounds([0, 0, 0], [SIZE.x - 1, SIZE.y - 1, SIZE.z - 1]);
  const quality = gpu.software ? "low" : "medium";
  renderer.setQuality({
    ...QUALITY_PRESETS[quality],
    maxSteps: Math.min(4096, QUALITY_PRESETS[quality].maxSteps * SPAN),
  });

  // --- camera ---------------------------------------------------------------------
  const target: Vec3 = [CX, BASE_Y + 30, CZ];
  const far = 430 * SPAN;
  const camera = makeCamera({ target, distance: far, pitchDeg: 30, fovDeg: 42 });
  let distance = Math.max(300, VILLAGE_R * 2.9);
  const orbit = makeOrbitControl(canvas, { start: 35, min: -Infinity, max: Infinity, onChange: () => loop.invalidate() });
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      distance = Math.max(90, Math.min(far * 1.7, distance * (1 + Math.sign(e.deltaY) * 0.1)));
      loop.invalidate();
    },
    { passive: false },
  );

  const adapter = gpu.adapterInfo;
  const perf = makePerf({
    enabled: params.has("perf"),
    scale: gpu.renderScale,
    minScale: gpu.software ? 0.25 : 0.35,
    maxSampleMs: 4000,
    label:
      ([adapter.vendor, adapter.architecture, adapter.description].filter(Boolean).join(" · ") || "unknown adapter") +
      `${gpu.software ? " (software)" : ""} · quality ${quality}`,
  });

  let spin = true;
  let streamWorld: (() => void) | null = null;
  const loop = runLoop((now) => {
    streamWorld?.();
    perf.frame(now);
    gpu.renderScale = perf.scale();
    resizeToDisplay(gpu);
    const yaw = orbit.yaw() + (spin ? now / 320 : 0);
    renderer.render({ ...camera(yaw, distance, target), ...DAYLIGHT });
  }, true);
  observeResize(canvas, loop);
  canvas.addEventListener("pointerdown", () => {
    spin = false;
    loop.setContinuous(false);
  });

  // --- species ----------------------------------------------------------------------
  // As in the forest: a handful of variants per species, generated on workers,
  // then placed many times in any of the eight axis-aligned orientations.
  const VARIANTS = Math.max(1, Number(params.get("variants") ?? 10));
  const HOUSE_VARIANTS = 4;
  const useWorkers = params.get("workers") !== "0";

  interface Species {
    key: string;
    generator: string;
    count: number;
    params: (n: number) => unknown;
    make: (n: number) => Entity;
  }

  const house = (kind: (typeof HOUSE_KINDS)[number], n: number): BuildingParams => {
    const f = n / Math.max(1, HOUSE_VARIANTS - 1);
    let p: BuildingParams;
    if (kind === "cottage") {
      p = structuredClone(BUILDINGS.cottage);
      p.shape.width = Math.round(66 + f * 20);
      p.shape.depth = 46 + (n % 2) * 6;
    } else if (kind === "farmhouse") {
      p = structuredClone(BUILDINGS.farmhouse);
      p.shape.width = Math.round(84 + f * 18);
      p.shape.depth = 50 + (n % 2) * 6;
    } else {
      // A brick farmhouse: the farmhouse's shape in brick under slate.
      p = structuredClone(BUILDINGS.farmhouse);
      p.species = "brick";
      p.shape.width = Math.round(72 + f * 16);
      p.shape.depth = 48;
      p.shape.storeys = n % 3 === 2 ? 1 : 2;
      p.look.wall = "brick";
      p.look.roofStyle = "slate";
      p.look.quoins = n % 2 === 0;
      p.openings.shutters = 0.5;
    }
    p.look.lit = 0.12;
    return p;
  };

  const species: Species[] = [
    ...TREE_KINDS.map((kind): Species => {
      const at = (n: number) => {
        const p = structuredClone(TREES[kind]);
        p.shape.height = Math.round(80 + (n / VARIANTS) * 40);
        p.look.season = season;
        p.look.age = 0.35 + (n / VARIANTS) * 0.6;
        return p;
      };
      return {
        key: `tree:${kind}:${season}`,
        generator: kind === "spruce" ? "voxolith/tree.conifer" : "voxolith/tree.broadleaf",
        count: VARIANTS,
        params: at,
        make: (n) => generateTree(at(n), seededRandom(seed + n * 977)).entity,
      };
    }),
    ...BUSH_KINDS.map((kind): Species => {
      const at = (n: number) => {
        const p = structuredClone(BUSHES[kind]);
        p.shape.height = Math.round(26 + (n / VARIANTS) * 20);
        p.look.season = season;
        return p;
      };
      return { key: `bush:${kind}:${season}`, generator: "voxolith/bush", count: VARIANTS, params: at, make: (n) => generateBush(at(n), seededRandom(seed + 5000 + n * 131)).entity };
    }),
    ...GRASS_KINDS.map((kind): Species => {
      const at = (n: number) => {
        const p = structuredClone(GRASSES[kind]);
        p.shape.height = Math.round(14 + (n / VARIANTS) * 12);
        p.look.season = season;
        return p;
      };
      return { key: `grass:${kind}:${season}`, generator: "voxolith/grass", count: VARIANTS, params: at, make: (n) => generateGrass(at(n), seededRandom(seed + 9000 + n * 71)).entity };
    }),
    ...ROCK_KINDS.map((kind): Species => {
      const at = (n: number) => {
        const p = structuredClone(ROCKS[kind]);
        const f = n / VARIANTS;
        p.shape.size = Math.round(p.shape.size * (kind === "outcrop" ? 0.8 + f * 0.5 : 0.45 + f * 0.6));
        return p;
      };
      return {
        // The palette key is the skin, not the preset: boulder, mossy and
        // pebbles are all granite and can share one range.
        key: `rock:${ROCKS[kind].species}:${kind}`,
        generator: kind === "outcrop" ? "voxolith/outcrop" : "voxolith/rock",
        count: Math.min(VARIANTS, 6),
        params: at,
        make: (n) => generateRock(at(n), seededRandom(seed + 13000 + n * 53)).entity,
      };
    }),
    ...HOUSE_KINDS.map((kind): Species => ({
      key: `house:${kind}`,
      generator: "voxolith/house",
      count: HOUSE_VARIANTS,
      params: (n) => house(kind, n),
      make: (n) => generateBuilding(house(kind, n), seededRandom(seed + 17000 + n * 389)).entity,
    })),
  ];
  const paletteKey = (key: string) => (key.startsWith("rock:") ? key.split(":").slice(0, 2).join(":") : key);

  const pools = new Map<string, VariantPool>();
  const models = new Map<string, Entity[]>();

  async function buildPools(): Promise<number> {
    const report = (done: number, total: number) => {
      info.textContent = `generating ${done}/${total} models`;
    };
    const total = species.reduce((n, sp) => n + sp.count, 0);
    const adopt = (sp: Species, mine: Entity[]) => {
      models.set(sp.key, mine);
      pools.set(sp.key, makeVariantPool({ count: mine.length, make: (i) => mine[i] }));
    };
    if (useWorkers && typeof Worker !== "undefined") {
      const workers = makeGeneratorPool({
        spawn: () => new Worker(new URL("./gen.worker.ts", import.meta.url), { type: "module" }),
      });
      try {
        await workers.ready();
        const specs = species.flatMap((sp, si) =>
          Array.from({ length: sp.count }, (_, n) => ({
            generator: sp.generator,
            params: sp.params(n),
            seed: seed + si * 7919 + n * 977,
            entityId: `${sp.key}-${n}`,
          })),
        );
        const out = await workers.generateMany(specs, report);
        let i = 0;
        for (const sp of species) { adopt(sp, out.slice(i, i + sp.count)); i += sp.count; }
        return out.length;
      } catch (err) {
        console.warn("[village] worker generation failed, falling back to the main thread:", err);
      } finally {
        workers.destroy();
      }
    }
    let done = 0;
    for (const sp of species) {
      adopt(sp, Array.from({ length: sp.count }, (_, n) => { const e = sp.make(n); report(++done, total); return e; }));
    }
    return done;
  }

  const t0 = performance.now();
  const modelCount = await buildPools();
  const tModels = performance.now() - t0;
  info.textContent = "laying out the village";

  // --- houses ---------------------------------------------------------------------------
  // Sites come from a coarse jittered grid, dense near the middle and sparse
  // outside, so there is a village and a few outlying farms. Each is turned so
  // its door faces the village centre, then accepted only if it clears the ones
  // already placed. All of it is one deterministic pass over the whole world.
  interface House {
    entity: Entity;
    orientation: Orientation;
    /** World position of the model's anchor (footprint centre, ground level). */
    x: number;
    z: number;
    y: number;
    /** World-space box of the oriented model. */
    x0: number; z0: number; x1: number; z1: number;
    /** Where the path starts: just beyond the foot of the steps. */
    door: [number, number];
    key: string;
  }

  /** The front steps' centre in model space: the frontmost row at ground level. */
  const doorOf = (e: Entity): [number, number] => {
    const { x: sx, y: sy, z: sz } = e.model.size;
    for (let z = sz - 1; z >= 0; z--) {
      let lo = -1, hi = -1;
      for (let x = 0; x < sx; x++) if (e.model.data[x + 0 * sx + z * sx * sy]) { if (lo < 0) lo = x; hi = x; }
      if (lo >= 0 && hi - lo < sx / 2) return [(lo + hi) / 2, z + 3];
    }
    return [sx / 2, sz + 3];
  };

  const houses: House[] = [];
  {
    const candidates: { x: number; z: number; rng: () => number; d: number }[] = [];
    scatterRegion({ cell: 140, seed, salt: 21, jitter: 0.3 }, 0, 0, SIZE.x - 1, SIZE.z - 1, (pt) => {
      const d = Math.hypot(pt.x - CX, pt.z - CZ);
      const chance = 0.72 * (1 - smooth(VILLAGE_R * 0.7, VILLAGE_R * 1.2, d)) + 0.1;
      if (pt.rng() > chance) return;
      candidates.push({ x: pt.x, z: pt.z, rng: pt.rng, d });
    });
    // Nearest the centre first, so the core fills before the outskirts.
    candidates.sort((a, b) => a.d - b.d || a.x - b.x || a.z - b.z);
    for (const c of candidates) {
      const r = c.rng();
      const kind = r < 0.45 ? "cottage" : r < 0.75 ? "farmhouse" : "brick";
      const key = `house:${kind}`;
      const list = models.get(key)!;
      const entity = list[Math.floor(c.rng() * list.length) % list.length];
      const door = doorOf(entity);
      const { anchor, size } = entity.model;
      // Four yaws (and a mirror for variety): keep the one whose door looks
      // most towards the centre, or anywhere for the house at the centre.
      const toC = [CX - c.x, CZ - c.z];
      const lenC = Math.hypot(toC[0], toC[1]) || 1;
      let best: Orientation = 0, bestDot = -Infinity;
      const mirror = c.rng() < 0.5 ? 4 : 0;
      for (let yaw = 0; yaw < 4; yaw++) {
        const o = (yaw | mirror) as Orientation;
        const a = orientAnchor(o, anchor, size);
        const p = orientVoxel(o, door[0], 0, door[1], size, [0, 0, 0]);
        const dx = p[0] - a[0], dz = p[2] - a[2];
        const dot = (dx * toC[0] + dz * toC[1]) / (Math.hypot(dx, dz) * lenC) + c.rng() * 0.15;
        if (dot > bestDot) { bestDot = dot; best = o; }
      }
      const a = orientAnchor(best, anchor, size);
      const os = orientedSize(size, best);
      const x0 = Math.round(c.x - a[0]), z0 = Math.round(c.z - a[2]);
      const x1 = x0 + os.x - 1, z1 = z0 + os.z - 1;
      if (x0 < 12 || z0 < 12 || x1 >= SIZE.x - 12 || z1 >= SIZE.z - 12) continue;
      const gap = 14;
      if (houses.some((h) => x0 - gap < h.x1 && x1 + gap > h.x0 && z0 - gap < h.z1 && z1 + gap > h.z0)) continue;
      const dp = orientVoxel(best, door[0], 0, door[1], size, [0, 0, 0]);
      houses.push({ entity, orientation: best, x: c.x, z: c.z, y: 0, x0, z0, x1, z1, door: [x0 + dp[0], z0 + dp[2]], key });
    }
  }

  // Level a pad under each house at its average ground height, and blend the
  // terrain back to its own shape over a short apron. A trodden yard marks it.
  const surface = new Uint8Array(SIZE.x * SIZE.z); // 0 turf, 1 yard, 2 path
  const APRON = 14;
  for (const h of houses) {
    let sum = 0, n = 0;
    for (let z = h.z0; z <= h.z1; z++) for (let x = h.x0; x <= h.x1; x++) { sum += height[x + z * SIZE.x]; n++; }
    const pad = Math.round(sum / n);
    h.y = pad + 1;
    for (let z = h.z0 - APRON; z <= h.z1 + APRON; z++)
      for (let x = h.x0 - APRON; x <= h.x1 + APRON; x++) {
        if (x < 0 || z < 0 || x >= SIZE.x || z >= SIZE.z) continue;
        const ex = Math.max(h.x0 - x, 0, x - h.x1), ez = Math.max(h.z0 - z, 0, z - h.z1);
        const e = Math.hypot(ex, ez);
        if (e > APRON) continue;
        const i = x + z * SIZE.x;
        const w = 1 - smooth(2, APRON, e);
        height[i] = Math.round(pad * w + height[i] * (1 - w));
        if (e > 0 && e < 6 && noise.value2(x * 0.2, z * 0.2) > 0.35) surface[i] = Math.max(surface[i], 1);
      }
  }

  // Footpaths: a minimum spanning tree over the doors, so every house is on
  // the network by the shortest total length. A path wanders a little and
  // never runs through a house.
  const inHouse = (x: number, z: number, m = 0) => houses.some((h) => x >= h.x0 - m && x <= h.x1 + m && z >= h.z0 - m && z <= h.z1 + m);
  const pathNear = new Uint8Array(SIZE.x * SIZE.z);
  {
    const pts = houses.map((h) => h.door);
    const inTree = new Uint8Array(pts.length);
    const edges: [number, number][] = [];
    if (pts.length) inTree[0] = 1;
    for (let k = 1; k < pts.length; k++) {
      let bi = -1, bj = -1, bd = Infinity;
      for (let i = 0; i < pts.length; i++) {
        if (!inTree[i]) continue;
        for (let j = 0; j < pts.length; j++) {
          if (inTree[j]) continue;
          const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
          if (d < bd) { bd = d; bi = i; bj = j; }
        }
      }
      inTree[bj] = 1;
      edges.push([bi, bj]);
    }
    const stamp = (cx: number, cz: number, r: number, mask: Uint8Array, v: number) => {
      for (let dz = -r; dz <= r; dz++)
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dz * dz > r * r + r) continue;
          const x = Math.round(cx + dx), z = Math.round(cz + dz);
          if (x < 0 || z < 0 || x >= SIZE.x || z >= SIZE.z) continue;
          mask[x + z * SIZE.x] = Math.max(mask[x + z * SIZE.x], v);
        }
    };
    for (const [i, j] of edges) {
      const [ax, az] = pts[i], [bx, bz] = pts[j];
      const len = Math.hypot(bx - ax, bz - az);
      const nx = -(bz - az) / (len || 1), nz = (bx - ax) / (len || 1);
      const steps = Math.ceil(len);
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        // Sway sideways, fading to zero at both doors.
        const sway = (noise.value2(i * 7.1 + t * len * 0.02, j * 3.3) - 0.5) * Math.min(40, len * 0.25) * Math.sin(Math.PI * t);
        const x = ax + (bx - ax) * t + nx * sway, z = az + (bz - az) * t + nz * sway;
        if (inHouse(Math.round(x), Math.round(z), 1)) continue;
        stamp(x, z, 3, surface, 2);
        stamp(x, z, 9, pathNear, 1);
      }
    }
  }
  let maxH = 0;
  for (let i = 0; i < height.length; i++) if (height[i] > maxH) maxH = height[i];

  // --- the world --------------------------------------------------------------------------
  const counted = new Map<Entity, number>();
  const sizeOf = (e: Entity): number => {
    let n = counted.get(e);
    if (n === undefined) { n = voxelCount(e.model); counted.set(e, n); }
    return n;
  };

  const CHUNK = 64;
  /**
   * `clear` is how far the root must stay from any wall; `open` how the layer
   * thins towards the village centre (0 = untouched, 1 = gone at the centre).
   */
  const LAYERS = [
    { key: "tree", kinds: TREE_KINDS, cell: 88, salt: 1, margin: 80, chance: 0.92, clear: 26, open: 0.85 },
    { key: "bush", kinds: BUSH_KINDS, cell: 64, salt: 2, margin: 36, chance: 0.9, clear: 8, open: 0.4 },
    { key: "rock", kinds: ROCK_KINDS, cell: 96, salt: 4, margin: 48, chance: 0.55, clear: 10, open: 0.3 },
    { key: "grass", kinds: GRASS_KINDS, cell: 50, salt: 3, margin: 24, chance: 0.9, clear: 2, open: 0 },
  ] as const;

  let voxels = 0, placed = 0, housesPlaced = 0, rocksPlaced = 0;
  let lastPaletteSize = -1;
  const allocate = (e: Entity, key: string) => {
    const { base } = palette.allocateFor(e, paletteKey(key));
    if (palette.used !== lastPaletteSize) {
      lastPaletteSize = palette.used;
      renderer.updatePalette(palette.buildPalette());
      const mats = palette.buildMaterials();
      if (mats) renderer.updateMaterials(mats);
    }
    return base;
  };

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
            const i = wx + wz * SIZE.x;
            const h = height[i];
            const top = Math.min(h, oy + 7);
            const surf = surface[i];
            const n = noise.value2(wx * 0.3, wz * 0.3);
            const topRole = surf === 2 ? (n > 0.55 ? PATH2 : PATH) : surf === 1 ? YARD : n > 0.5 ? TURF : TURF2;
            for (let wy = oy; wy <= top; wy++) {
              cells[lx + (wy - oy) * 8 + lz * 64] = wy === h ? topRole : wy > h - 3 ? SOIL : ROCK;
              touched = true;
            }
          }
        }
        return touched;
      });

      // Houses first: each chunk stamps the part of every house that reaches it.
      for (const hs of houses) {
        if (hs.x1 < ctx.box.x0 || hs.x0 > ctx.box.x1 || hs.z1 < ctx.box.z0 || hs.z0 > ctx.box.z1) continue;
        ctx.blit(hs.entity.model, { x: hs.x, y: hs.y, z: hs.z }, allocate(hs.entity, hs.key), hs.orientation);
        if (hs.x >= ctx.box.x0 && hs.x <= ctx.box.x1 && hs.z >= ctx.box.z0 && hs.z <= ctx.box.z1) {
          housesPlaced++;
          voxels += sizeOf(hs.entity);
        }
      }

      for (const layer of LAYERS) {
        scatterRegion(
          { cell: layer.cell, seed, salt: layer.salt },
          ctx.box.x0 - layer.margin, ctx.box.z0 - layer.margin,
          ctx.box.x1 + layer.margin, ctx.box.z1 + layer.margin,
          (pt) => {
            if (pt.x < 0 || pt.z < 0 || pt.x >= SIZE.x || pt.z >= SIZE.z) return;
            const d = Math.hypot(pt.x - CX, pt.z - CZ);
            const thin = layer.open * (1 - smooth(VILLAGE_R * 0.5, VILLAGE_R * 1.2, d));
            if (pt.rng() > layer.chance * (1 - thin)) return;
            const i = pt.x + pt.z * SIZE.x;
            if (surface[i] === 2 || pathNear[i]) return;
            if (inHouse(pt.x, pt.z, layer.clear)) return;
            const kind = layer.kinds[Math.min(layer.kinds.length - 1, (pt.rng() * layer.kinds.length) | 0)];
            const key =
              layer.key === "rock" ? `rock:${ROCKS[kind].species}:${kind}` : `${layer.key}:${kind}:${season}`;
            const v = pools.get(key)!.at((pt.rng() * 1e6) | 0, pt.rng);
            ctx.blit(v.entity.model, { x: pt.x, y: height[i] + 1, z: pt.z }, allocate(v.entity, key), v.orientation);
            if (pt.x >= ctx.box.x0 && pt.x <= ctx.box.x1 && pt.z >= ctx.box.z0 && pt.z <= ctx.box.z1) {
              placed++;
              if (layer.key === "rock") rocksPlaced++;
              voxels += sizeOf(v.entity);
            }
          },
        );
      }
    },
  });

  const RADIUS = Number(params.get("radius") ?? SIZE.x * 1.5);
  world.focus(CX, CZ, RADIUS);
  const totalChunks = world.pending;
  while (world.pending) {
    const left = world.step(12);
    info.textContent = `building ${totalChunks - left}/${totalChunks} chunks`;
    loop.invalidate();
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  }

  let focusX = target[0], focusZ = target[2];
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
    `${housesPlaced} houses, ${rocksPlaced} rocks, ${placed - rocksPlaced} plants from ${modelCount} models · ` +
    `${(tModels / 1000).toFixed(1)}s gen, ${secs}s total · ${(voxels / 1000).toFixed(0)}k voxels · ` +
    `${palette.used}/255 palette slots · ${(mem.bytes / 1048576).toFixed(0)} MB of bricks · drag to orbit, wheel to zoom`;
  loop.invalidate();
}
