// world — a valley from the generators: terrain and river, a village, a forest.
//
// Everything here is generated. `@voxolith/gen-terrain` makes the ground and
// the river; the entity generators make every tree, shrub, rock and house.
// What this page adds is the *settlement*: where the village goes, where each
// house stands, levelled pads, footpaths between the doors, and how the forest
// thins out around them. That layout is decided once, up front and
// deterministically, and the chunked world only reads it, so the world still
// streams in any order.
//
// The village and the forest are two areas of one map that overlap a little:
// the woods thin out towards the village, a few trees stand among the houses.
// A draggable lamp starts in a glade in the forest; N (or the button) runs day
// into night and back. The water ripples, so the page renders continuously
// (`?still` freezes it and renders on demand).

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
import { createInput, makeOrbitController, prepareSurface, recogniseGestures } from "@voxolith/engine/input";
import { generateTerrain } from "@voxolith/gen-terrain";
import {
  approach,
  atmosphereFrame,
  ATMOSPHERES,
  makeAtmosphereTransition,
  timeOfDay,
  type AtmosphereName,
} from "@voxolith/engine/atmosphere";
import { generateTree, PRESETS as TREES } from "@voxolith/gen-tree";
import { generateBush, PRESETS as BUSHES } from "@voxolith/gen-bush";
import { generateGrass, PRESETS as GRASSES } from "@voxolith/gen-grass";
import { generateRock, PRESETS as ROCKS } from "@voxolith/gen-rock";
import { generateBuilding, PRESETS as BUILDINGS, type BuildingParams } from "@voxolith/gen-building";
import { boot, runLoop } from "../shared/boot";

// One tile is 320 voxels square; `scale` lays out SPANxSPAN of them.
const params = new URLSearchParams(location.search);
const SPAN = Math.max(1, Math.min(8, Math.round(Number(params.get("scale") ?? 4))));
const TILE = 320;
const SIZE = { x: TILE * SPAN, y: 192, z: TILE * SPAN };
/** Radius of the village area. */
const VILLAGE_R = Math.max(100, 70 * SPAN);
/** Radius of the clearing round the lamp's starting spot. */
const GLADE = 60;

const seed = hashSeed(params.get("seed") ?? "voxolith");
const season = (params.get("season") ?? "summer") as "spring" | "summer" | "autumn" | "winter";
const still = params.has("still");
const TREE_KINDS = ["oak", "birch", "spruce"] as const;
const BUSH_KINDS = ["bush", "bramble"] as const;
const GRASS_KINDS = ["grass", "meadow", "fern"] as const;
const ROCK_KINDS = ["boulder", "mossy", "pebbles", "outcrop"] as const;
const HOUSE_KINDS = ["cottage", "farmhouse", "brick"] as const;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const app = await boot("world");
if (app) {
  const { gpu, canvas, info } = app;
  const noise = makeNoise(seed);

  // --- terrain --------------------------------------------------------------
  // The ground and the river come from the terrain generator; the settlement
  // below edits its heights in place (levelled pads) before anything is built.
  const terrain = generateTerrain(
    {
      width: SIZE.x, depth: SIZE.z, height: SIZE.y,
      featureSize: 110 + 25 * SPAN,
      river: { enabled: true, width: 14 + 3 * SPAN, depth: 5, banks: 16 + 2 * SPAN, meander: 260 + 70 * SPAN },
    },
    seed,
  );
  const W = terrain.width, D = terrain.depth;
  const S = terrain.waterLevel - 1; // top water voxel
  const heightAt = (x: number, z: number) => terrain.heights[x + z * W];

  // --- palette ----------------------------------------------------------------
  // Every species takes its own slot range; each house style is 32 roles, so
  // the lists are short and the three granite rock styles share one range.
  const palette = new PaletteAllocator(1);
  const { base: terrainBase } = palette.allocate(terrain.roles, "terrain");
  const settlement: Role[] = [
    { id: "path", name: "Path", color: [0.46, 0.38, 0.27] },
    { id: "path.worn", name: "Path worn", color: [0.53, 0.46, 0.34] },
    { id: "yard", name: "Trodden turf", color: [0.36, 0.42, 0.24] },
  ];
  const { base: s0 } = palette.allocate(settlement, "settlement");
  const PATH = s0, PATH2 = s0 + 1, YARD = s0 + 2;

  const renderer: Renderer = await createRenderer(gpu, { size: SIZE, palette: palette.buildPalette(), materials: palette.buildMaterials() });
  renderer.setClipBounds([0, 0, 0], [SIZE.x - 1, SIZE.y - 1, SIZE.z - 1]);
  const quality = gpu.software ? "low" : "medium";
  renderer.setQuality({
    ...QUALITY_PRESETS[quality],
    maxSteps: Math.min(4096, QUALITY_PRESETS[quality].maxSteps * SPAN),
  });

  // --- where things go -----------------------------------------------------------
  /** Fraction of dry, gently sloping columns in a disc, sampled coarsely. */
  const buildable = (cx: number, cz: number, r: number) => {
    let good = 0, n = 0;
    for (let a = 0; a < 24; a++)
      for (const k of [0.3, 0.65, 1]) {
        const x = Math.round(cx + Math.cos((a / 24) * Math.PI * 2) * r * k);
        const z = Math.round(cz + Math.sin((a / 24) * Math.PI * 2) * r * k);
        n++;
        if (x < 1 || z < 1 || x >= W - 1 || z >= D - 1) continue;
        const h = heightAt(x, z);
        if (h > S + 1 && Math.abs(h - heightAt(x + 4 < W ? x + 4 : x, z)) <= 2) good++;
      }
    return good / n;
  };
  const waterWithin = (cx: number, cz: number, r: number) => {
    for (let a = 0; a < 32; a++) {
      const x = Math.round(cx + Math.cos((a / 32) * Math.PI * 2) * r), z = Math.round(cz + Math.sin((a / 32) * Math.PI * 2) * r);
      if (x >= 0 && z >= 0 && x < W && z < D && terrain.waterAt(x, z)) return true;
    }
    return false;
  };
  /** Best spot in a search box: dry and flat, optionally near water, away from `avoid`. */
  const findSpot = (x0: number, x1: number, z0: number, z1: number, r: number, nearWater: boolean, avoid?: [number, number], minDist = 0): [number, number] => {
    let best: [number, number] = [(x0 + x1) / 2, (z0 + z1) / 2], bestScore = -Infinity;
    const step = Math.max(12, Math.round(r / 5));
    for (let z = z0; z <= z1; z += step)
      for (let x = x0; x <= x1; x += step) {
        if (avoid && Math.hypot(x - avoid[0], z - avoid[1]) < minDist) continue;
        let score = buildable(x, z, r);
        if (nearWater && waterWithin(x, z, r * 1.25)) score += 0.25;
        score -= Math.hypot(x - (x0 + x1) / 2, z - (z0 + z1) / 2) / (W * 4); // prefer the box centre
        if (score > bestScore) { bestScore = score; best = [x, z]; }
      }
    return best;
  };
  // The village on one side of the map, near the river; the lamp's glade on the other.
  const VC = findSpot(W * 0.22, W * 0.5, D * 0.3, D * 0.7, VILLAGE_R * 0.6, true);
  const GC = findSpot(W * 0.55, W * 0.85, D * 0.25, D * 0.75, GLADE, false, VC, VILLAGE_R * 1.6);
  const dVillage = (x: number, z: number) => Math.hypot(x - VC[0], z - VC[1]);

  // --- camera and loop -----------------------------------------------------------
  const far = 430 * SPAN;
  const night0 = params.get("time") === "night";
  const camera = makeCamera({ target: [W / 2, 40, D / 2], distance: far, pitchDeg: 24, fovDeg: 42 });
  prepareSurface(canvas, { contextMenu: false });
  const input = createInput(canvas, { loop: { invalidate: () => loop.invalidate() } });
  // Drag turns, right-drag or two fingers pan across the valley, wheel or pinch zooms.
  const orbit = makeOrbitController(input, {
    yaw: 35, pitchLimits: [6, 80], distanceLimits: [90, far * 1.7], fovDeg: 42, pan: "secondary",
    // A moving view is the one time a render-scale probe cannot be seen.
    onChange: () => perf.reprobe(),
    panBounds: { minX: 0, maxX: W, minZ: 0, maxZ: D },
    // At night the lamp is the subject: start close, looking down into its glade.
    target: night0 ? [GC[0], heightAt(Math.round(GC[0]), Math.round(GC[1])) + 10, GC[1]] : [W / 2, terrain.params.baseY + 20, D / 2],
    pitch: night0 ? 42 : 24,
    distance: night0 ? Math.min(far, 260) : far,
  });
  const frame = () => camera(orbit.yaw(), orbit.distance(), orbit.target(), orbit.pitch());

  const adapter = gpu.adapterInfo;
  const perf = makePerf({
    enabled: params.has("perf"),
    scale: gpu.renderScale,
    minScale: gpu.software ? 0.25 : 0.35,
    maxSampleMs: 4000,
    // The water keeps this page rendering while the view is still; never
    // re-probe then, or each probe shows as a faint resample of the image.
    retryAfterMs: Infinity,
    label:
      ([adapter.vendor, adapter.architecture, adapter.description].filter(Boolean).join(" · ") || "unknown adapter") +
      `${gpu.software ? " (software)" : ""} · quality ${quality}`,
  });

  // Time of day: 0.5 is noon, 1.0 midnight. A toggle always runs forwards.
  const TRANSITION_S = 2.5;
  let phase = night0 ? 1.0 : 0.5;
  let phaseTarget = phase;

  // Weather. The engine only describes and blends it; the rules are this
  // page's: rain wets the ground and it dries slowly afterwards, snow settles
  // while it falls and melts in rain or clear weather.
  const WEATHERS: AtmosphereName[] = ["clear", "cloudy", "rain", "storm", "snow", "fog"];
  const w0 = (params.get("weather") ?? "clear") as AtmosphereName;
  let weatherName: AtmosphereName = w0 in ATMOSPHERES ? w0 : "clear";
  const weather = makeAtmosphereTransition(ATMOSPHERES[weatherName]);
  // Start already soaked or snowed-in when the page opens that way.
  let wetness = weatherName === "rain" || weatherName === "storm" ? 0.8 : 0;
  let snowCover = weatherName === "snow" ? 0.75 : 0;
  const stepGround = (dt: number) => {
    const w = weather.current();
    const p = w.precipitation;
    const raining = p.kind === "rain" ? p.intensity : 0;
    const snowing = p.kind === "snow" ? p.intensity : 0;
    wetness = raining > 0 ? approach(wetness, 1, 0.12 * raining, dt) : approach(wetness, 0, 0.02, dt);
    if (snowing > 0) snowCover = approach(snowCover, 0.9, 0.05 * snowing, dt);
    else snowCover = approach(snowCover, 0, raining > 0 ? 0.05 : 0.012, dt);
  };
  const settling = () => weather.changing() || (wetness > 0 && weather.current().precipitation.kind !== "rain") || (snowCover > 0 && weather.current().precipitation.kind !== "snow") || weather.current().precipitation.intensity > 0;
  let spin = true;
  let streamWorld: (() => void) | null = null;
  const wantContinuous = () => !still || spin || phase < phaseTarget || settling();
  const loop = runLoop((now, dt) => {
    streamWorld?.();
    perf.frame(now);
    gpu.renderScale = perf.scale();
    resizeToDisplay(gpu);
    if (spin) orbit.set({ yaw: orbit.yaw() + dt * 3.2 });
    if (phase < phaseTarget) phase = Math.min(phaseTarget, phase + dt * (0.5 / TRANSITION_S));
    loop.setContinuous(wantContinuous());
    const sky = weather.update(dt);
    stepGround(dt);
    const atm = atmosphereFrame(timeOfDay(phase), { ...sky, wetness, cover: snowCover });
    renderer.render({ ...frame(), ...atm, time: still ? 0 : now / 1000 });
  }, true);
  observeResize(canvas, loop);
  input.on((e) => {
    if (e.kind !== "pointer" || e.phase !== "down" || !spin) return;
    spin = false;
    loop.setContinuous(wantContinuous());
  });

  // --- species ----------------------------------------------------------------------
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
  // Rock styles that share a skin share one palette range.
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
        console.warn("[world] worker generation failed, falling back to the main thread:", err);
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
  // Sites come from a coarse jittered grid, dense in the village and rare
  // outside (a few outlying farms). Each is turned so its door faces the
  // village centre and accepted only on dry ground clear of the water and of
  // the houses already placed.
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
  /** Dry ground under the whole box, with a margin from the water. */
  const dryBox = (x0: number, z0: number, x1: number, z1: number, m: number) => {
    for (let z = z0 - m; z <= z1 + m; z += 3)
      for (let x = x0 - m; x <= x1 + m; x += 3) {
        if (x < 0 || z < 0 || x >= W || z >= D) return false;
        if (heightAt(x, z) <= S + 1) return false;
      }
    return true;
  };

  const houses: House[] = [];
  {
    const candidates: { x: number; z: number; rng: () => number; d: number }[] = [];
    scatterRegion({ cell: 90, seed, salt: 21, jitter: 0.3 }, 0, 0, W - 1, D - 1, (pt) => {
      const d = dVillage(pt.x, pt.z);
      const chance = 0.8 * (1 - smooth(VILLAGE_R * 0.6, VILLAGE_R * 1.1, d)) + 0.04;
      if (pt.rng() > chance) return;
      candidates.push({ x: pt.x, z: pt.z, rng: pt.rng, d });
    });
    candidates.sort((a, b) => a.d - b.d || a.x - b.x || a.z - b.z);
    for (const c of candidates) {
      const r = c.rng();
      const kind = r < 0.45 ? "cottage" : r < 0.75 ? "farmhouse" : "brick";
      const key = `house:${kind}`;
      const list = models.get(key)!;
      const entity = list[Math.floor(c.rng() * list.length) % list.length];
      const door = doorOf(entity);
      const { anchor, size } = entity.model;
      const toC = [VC[0] - c.x, VC[1] - c.z];
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
      if (x0 < 12 || z0 < 12 || x1 >= W - 12 || z1 >= D - 12) continue;
      if (!dryBox(x0, z0, x1, z1, 4)) continue;
      if (Math.hypot(c.x - GC[0], c.z - GC[1]) < GLADE + 60) continue;
      const gap = 12;
      if (houses.some((h) => x0 - gap < h.x1 && x1 + gap > h.x0 && z0 - gap < h.z1 && z1 + gap > h.z0)) continue;
      const dp = orientVoxel(best, door[0], 0, door[1], size, [0, 0, 0]);
      houses.push({ entity, orientation: best, x: c.x, z: c.z, y: 0, x0, z0, x1, z1, door: [x0 + dp[0], z0 + dp[2]], key });
    }
  }

  // Level a pad under each house at its average ground height, blending the
  // terrain back over a short apron. A trodden yard marks it.
  const surface = new Uint8Array(W * D); // 0 terrain, 1 yard, 2 path
  const APRON = 14;
  for (const h of houses) {
    let sum = 0, n = 0;
    for (let z = h.z0; z <= h.z1; z++) for (let x = h.x0; x <= h.x1; x++) { sum += heightAt(x, z); n++; }
    const pad = Math.round(sum / n);
    h.y = pad + 1;
    for (let z = h.z0 - APRON; z <= h.z1 + APRON; z++)
      for (let x = h.x0 - APRON; x <= h.x1 + APRON; x++) {
        if (x < 0 || z < 0 || x >= W || z >= D) continue;
        const ex = Math.max(h.x0 - x, 0, x - h.x1), ez = Math.max(h.z0 - z, 0, z - h.z1);
        const e = Math.hypot(ex, ez);
        if (e > APRON) continue;
        const i = x + z * W;
        const w = 1 - smooth(2, APRON, e);
        terrain.heights[i] = Math.round(pad * w + terrain.heights[i] * (1 - w));
        if (e > 0 && e < 6 && noise.value2(x * 0.2, z * 0.2) > 0.35) surface[i] = Math.max(surface[i], 1);
      }
  }

  // Footpaths: a minimum spanning tree over the doors. A path wanders a little,
  // never runs through a house, and fords the river (it is not drawn on water).
  const inHouse = (x: number, z: number, m = 0) => houses.some((h) => x >= h.x0 - m && x <= h.x1 + m && z >= h.z0 - m && z <= h.z1 + m);
  const pathNear = new Uint8Array(W * D);
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
          if (x < 0 || z < 0 || x >= W || z >= D) continue;
          if (v === 2 && terrain.waterAt(x, z)) continue;
          mask[x + z * W] = Math.max(mask[x + z * W], v);
        }
    };
    for (const [i, j] of edges) {
      const [ax, az] = pts[i], [bx, bz] = pts[j];
      const len = Math.hypot(bx - ax, bz - az);
      const nx = -(bz - az) / (len || 1), nz = (bx - ax) / (len || 1);
      const steps = Math.ceil(len);
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const sway = (noise.value2(i * 7.1 + t * len * 0.02, j * 3.3) - 0.5) * Math.min(40, len * 0.25) * Math.sin(Math.PI * t);
        const x = ax + (bx - ax) * t + nx * sway, z = az + (bz - az) * t + nz * sway;
        if (inHouse(Math.round(x), Math.round(z), 1)) continue;
        stamp(x, z, 3, surface, 2);
        stamp(x, z, 9, pathNear, 1);
      }
    }
  }
  const maxY = terrain.maxY();
  /** The settlement's surface over the terrain's: paths and yards. */
  const topOverride = (x: number, z: number) => {
    const s = surface[x + z * W];
    if (s === 2) return noise.value2(x * 0.3, z * 0.3) > 0.55 ? PATH2 : PATH;
    if (s === 1) return YARD;
    return 0;
  };

  // --- the world --------------------------------------------------------------------------
  const counted = new Map<Entity, number>();
  const sizeOf = (e: Entity): number => {
    let n = counted.get(e);
    if (n === undefined) { n = voxelCount(e.model); counted.set(e, n); }
    return n;
  };

  const CHUNK = 64;
  /**
   * `clear` is how far a root stays from any wall; `open` how much the layer
   * thins inside the village (1 = gone at its centre). The overlap is the band
   * between half the village radius and a little past its edge, where the
   * woods fade in.
   */
  const LAYERS = [
    { key: "tree", kinds: TREE_KINDS, cell: 88, salt: 1, margin: 80, chance: 0.92, clear: 26, open: 0.88, glade: GLADE },
    { key: "bush", kinds: BUSH_KINDS, cell: 64, salt: 2, margin: 36, chance: 0.9, clear: 8, open: 0.45, glade: GLADE * 0.6 },
    { key: "rock", kinds: ROCK_KINDS, cell: 96, salt: 4, margin: 48, chance: 0.55, clear: 10, open: 0.3, glade: GLADE * 0.6 },
    { key: "grass", kinds: GRASS_KINDS, cell: 50, salt: 3, margin: 24, chance: 0.9, clear: 2, open: 0, glade: 0 },
  ] as const;

  let voxels = 0, placed = 0, housesPlaced = 0, rocksPlaced = 0, treesPlaced = 0;
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
      ctx.edit({ ...ctx.box, y1: maxY }, (cells, ox, oy, oz) => terrain.fillBrick(cells, ox, oy, oz, terrainBase, topOverride));

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
            if (pt.x < 0 || pt.z < 0 || pt.x >= W || pt.z >= D) return;
            const thin = layer.open * (1 - smooth(VILLAGE_R * 0.5, VILLAGE_R * 1.15, dVillage(pt.x, pt.z)));
            if (pt.rng() > layer.chance * (1 - thin)) return;
            if (layer.glade && Math.hypot(pt.x - GC[0], pt.z - GC[1]) < layer.glade) return;
            const i = pt.x + pt.z * W;
            // Only rocks stand in the water, and only where it is shallow.
            if (terrain.waterAt(pt.x, pt.z) && (layer.key !== "rock" || terrain.waterDepth(pt.x, pt.z) > 2)) return;
            if (surface[i] === 2 || pathNear[i]) return;
            if (inHouse(pt.x, pt.z, layer.clear)) return;
            const kind = layer.kinds[Math.min(layer.kinds.length - 1, (pt.rng() * layer.kinds.length) | 0)];
            const key = layer.key === "rock" ? `rock:${ROCKS[kind].species}:${kind}` : `${layer.key}:${kind}:${season}`;
            const v = pools.get(key)!.at((pt.rng() * 1e6) | 0, pt.rng);
            ctx.blit(v.entity.model, { x: pt.x, y: heightAt(pt.x, pt.z) + 1, z: pt.z }, allocate(v.entity, key), v.orientation);
            if (pt.x >= ctx.box.x0 && pt.x <= ctx.box.x1 && pt.z >= ctx.box.z0 && pt.z <= ctx.box.z1) {
              placed++;
              if (layer.key === "rock") rocksPlaced++;
              if (layer.key === "tree") treesPlaced++;
              voxels += sizeOf(v.entity);
            }
          },
        );
      }
    },
  });

  // --- lamp ---------------------------------------------------------------------
  // A point light you can pick up and carry: it lights the ground and trunks
  // around it and casts moving shadows through them. Grab it near its glow;
  // double-click or double-tap the ground to drop it there.
  const HOVER = 7;
  const lamp: Vec3 = [GC[0], 0, GC[1]];
  const standAt = (x: number, z: number) =>
    Math.max(heightAt(Math.max(0, Math.min(W - 1, Math.round(x))), Math.max(0, Math.min(D - 1, Math.round(z)))), S) + HOVER;
  lamp[1] = standAt(lamp[0], lamp[2]);
  const updateLamp = () => {
    const lights: PointLight[] = [
      { position: lamp, color: [1.0, 0.7, 0.38], intensity: 2.6, range: 90, glow: 3.5 },
      // A soft unshadowed spill, so light still reaches just round a trunk.
      { position: lamp, color: [1.0, 0.75, 0.45], intensity: 0.25, range: 50, shadows: false },
    ];
    renderer.setLights(lights);
    loop.invalidate();
  };
  updateLamp();

  const lampOnScreen = (): [number, number] | null => {
    const f = frame();
    const v: Vec3 = [lamp[0] - f.camPos[0], lamp[1] - f.camPos[1], lamp[2] - f.camPos[2]];
    const z = v[0] * f.camFwd[0] + v[1] * f.camFwd[1] + v[2] * f.camFwd[2];
    if (z <= 0) return null;
    const x = (v[0] * f.camRight[0] + v[1] * f.camRight[1] + v[2] * f.camRight[2]) / z;
    const y = (v[0] * f.camUp[0] + v[1] * f.camUp[1] + v[2] * f.camUp[2]) / z;
    const rect = canvas.getBoundingClientRect();
    const aspect = canvas.width / canvas.height;
    return [
      rect.left + ((x / (aspect * f.tanHalfFov) + 1) / 2) * rect.width,
      rect.top + ((1 - y / f.tanHalfFov) / 2) * rect.height,
    ];
  };
  const moveLampTo = (clientX: number, clientY: number) => {
    const { origin, dir } = makeRay(canvas, frame(), clientX, clientY);
    const hit = terrain.pick(origin, dir, { water: true });
    if (!hit) return;
    lamp[0] = hit[0];
    lamp[2] = hit[2];
    lamp[1] = standAt(hit[0], hit[2]);
    updateLamp();
  };
  const nearLamp = (x: number, y: number) => {
    const s = lampOnScreen();
    return !!s && Math.hypot(x - s[0], y - s[1]) < 32;
  };
  // Grabbing the lamp claims the pointer first (priority 10), so the orbit
  // controller leaves that drag alone.
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
  // Hover feedback only; the input tracks pressed pointers, not a hovering mouse.
  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerType === "mouse" && e.buttons === 0) canvas.style.cursor = nearLamp(e.clientX, e.clientY) ? "grab" : "";
  });
  recogniseGestures(input, { doubleTap: (t) => moveLampTo(t.x, t.y) });
  // For the end-to-end checks (tools/input-e2e.ts): where the lamp is drawn.
  if (params.has("e2e")) {
    Object.assign(window, {
      worldLamp: () => lampOnScreen(),
      worldWeather: (name: AtmosphereName, seconds = 0) => { weatherName = name; weather.set(ATMOSPHERES[name], seconds); if (weatherSel) weatherSel.value = name; },
      worldGround: (wet: number, cover: number) => { wetness = wet; snowCover = cover; },
      worldPlaces: {
        village: VC,
        glade: GC,
        // The water column nearest the village, for looking at the river.
        water: (() => {
          let best: [number, number] = VC, bd = Infinity;
          for (let z = 0; z < D; z += 4) for (let x = 0; x < W; x += 4) {
            if (!terrain.waterAt(x, z) || terrain.waterDepth(x, z) < 4) continue;
            const d = Math.hypot(x - VC[0], z - VC[1]);
            if (d < bd) { bd = d; best = [x, z]; }
          }
          return best;
        })(),
      },
      worldLook: (x: number, z: number, distance: number, pitch: number, yaw?: number) => {
        spin = false;
        orbit.set({ target: [x, heightAt(Math.round(x), Math.round(z)) + 8, z], distance, pitch, ...(yaw === undefined ? {} : { yaw }) });
      },
    });
  }

  // --- day and night ------------------------------------------------------------
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
    loop.setContinuous(true);
  };
  timeBtn?.addEventListener("click", toggleTime);
  input.captureKeys(["KeyN"]);
  input.on((e) => {
    if (e.kind === "key" && e.phase === "down" && e.code === "KeyN" && !e.repeat) toggleTime();
  });
  syncButton();

  // Weather picker: a select in the HUD, W cycles, ?weather= starts there.
  const weatherSel = document.getElementById("weather") as HTMLSelectElement | null;
  const setWeather = (name: AtmosphereName) => {
    weatherName = name;
    weather.set(ATMOSPHERES[name], 4);
    if (weatherSel) weatherSel.value = name;
    loop.setContinuous(true);
  };
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
  input.captureKeys(["KeyW"]);
  input.on((e) => {
    if (e.kind === "key" && e.phase === "down" && e.code === "KeyW" && !e.repeat) {
      setWeather(WEATHERS[(WEATHERS.indexOf(weatherName) + 1) % WEATHERS.length]);
    }
  });

  // --- build and stream ---------------------------------------------------------
  const RADIUS = Number(params.get("radius") ?? SIZE.x * 1.5);
  const tgt = () => orbit.target();
  world.focus(tgt()[0], tgt()[2], RADIUS);
  const totalChunks = world.pending;
  while (world.pending) {
    const left = world.step(12);
    info.textContent = `building ${totalChunks - left}/${totalChunks} chunks`;
    loop.invalidate();
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  }
  // Keep the world following the view as it pans, at a bounded cost.
  let focusX = tgt()[0], focusZ = tgt()[2];
  streamWorld = () => {
    const [tx, , tz] = tgt();
    if (Math.abs(tx - focusX) < CHUNK / 2 && Math.abs(tz - focusZ) < CHUNK / 2) {
      if (world.pending) world.step(4);
      return;
    }
    focusX = tx;
    focusZ = tz;
    world.focus(focusX, focusZ, RADIUS);
    world.step(4);
  };

  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  const mem = renderer.stats();
  info.textContent =
    `${housesPlaced} houses, ${treesPlaced} trees, ${rocksPlaced} rocks, ${placed - rocksPlaced - treesPlaced} other plants from ${modelCount} models · ` +
    `${(tModels / 1000).toFixed(1)}s gen, ${secs}s total · ${(voxels / 1000).toFixed(0)}k voxels · ` +
    `${palette.used}/255 palette slots · ${(mem.bytes / 1048576).toFixed(0)} MB of bricks · ` +
    `drag the lamp · N night/day · W weather · drag to turn, right-drag to pan, wheel to zoom`;
  loop.invalidate();
}
