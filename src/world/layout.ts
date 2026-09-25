// The valley's design, shared by the world page and its 100 voxel/metre twin.
//
// Everything here is decided in the world page's own voxels (10 per metre):
// the terrain and river, which models exist, where the village and the
// lamp's glade go, each house's site and heading, the levelled pads, the
// footpaths, and which plant or rock stands where. A page at a finer scale
// runs exactly this and multiplies positions by its factor, so both show the
// same valley.

import { seededRandom } from "@voxolith/renderer/core";
import { orientAnchor, orientedSize, orientVoxel, scatterRegion, type Entity, type Orientation, type Variant, type VariantPool } from "@voxolith/engine";
import { makeNoise } from "@voxolith/gen-kit";
import { generateTerrain, type Terrain } from "@voxolith/gen-terrain";
import { generateTree, PRESETS as TREES } from "@voxolith/gen-tree";
import { generateBush, PRESETS as BUSHES } from "@voxolith/gen-bush";
import { generateGrass, PRESETS as GRASSES } from "@voxolith/gen-grass";
import { generateRock, PRESETS as ROCKS } from "@voxolith/gen-rock";
import { generateBuilding, PRESETS as BUILDINGS, type BuildingParams } from "@voxolith/gen-building";

/** One tile is 320 voxels square; `span` lays out span x span of them. */
export const TILE = 320;
/** Radius of the clearing round the lamp's starting spot. */
export const GLADE = 60;
export const TREE_KINDS = ["oak", "birch", "spruce"] as const;
export const BUSH_KINDS = ["bush", "bramble"] as const;
export const GRASS_KINDS = ["grass", "meadow", "fern"] as const;
export const ROCK_KINDS = ["boulder", "mossy", "pebbles", "outcrop"] as const;
export const HOUSE_KINDS = ["cottage", "farmhouse", "brick"] as const;
export const HOUSE_VARIANTS = 4;
export type Season = "spring" | "summer" | "autumn" | "winter";

export const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export const villageRadius = (span: number) => Math.max(100, 70 * span);

/** The ground and the river. The layout edits its heights (levelled pads). */
export function valleyTerrain(span: number, seed: number): Terrain {
  return generateTerrain(
    {
      width: TILE * span, depth: TILE * span, height: 192,
      featureSize: 110 + 25 * span,
      river: { enabled: true, width: 14 + 3 * span, depth: 5, banks: 16 + 2 * span, meander: 260 + 70 * span },
    },
    seed,
  );
}

export interface Species {
  key: string;
  generator: string;
  count: number;
  params: (n: number) => unknown;
  /** Main-thread fallback; workers get `workerSeed`. */
  make: (n: number) => Entity;
}

/** The seed a species' variant gets on a generator worker. */
export const workerSeed = (seed: number, species: number, n: number) => seed + species * 7919 + n * 977;

export function houseParams(kind: (typeof HOUSE_KINDS)[number], n: number): BuildingParams {
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
}

export function valleySpecies(seed: number, season: Season, variants: number): Species[] {
  const VARIANTS = variants;
  return [
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
      params: (n) => houseParams(kind, n),
      make: (n) => generateBuilding(houseParams(kind, n), seededRandom(seed + 17000 + n * 389)).entity,
    })),
  ];
}

/** Rock styles that share a skin share one palette range. */
export const paletteKey = (key: string) => (key.startsWith("rock:") ? key.split(":").slice(0, 2).join(":") : key);

export interface House {
  entity: Entity;
  /** Which variant of its species. */
  variant: number;
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

/**
 * The scatter layers. `clear` is how far a root stays from any wall; `open`
 * how much the layer thins inside the village (1 = gone at its centre). The
 * overlap is the band between half the village radius and a little past its
 * edge, where the woods fade in.
 */
export const LAYERS = [
  { key: "tree", kinds: TREE_KINDS, cell: 88, salt: 1, margin: 80, chance: 0.92, clear: 26, open: 0.88, glade: GLADE },
  { key: "bush", kinds: BUSH_KINDS, cell: 64, salt: 2, margin: 36, chance: 0.9, clear: 8, open: 0.45, glade: GLADE * 0.6 },
  { key: "rock", kinds: ROCK_KINDS, cell: 96, salt: 4, margin: 48, chance: 0.55, clear: 10, open: 0.3, glade: GLADE * 0.6 },
  { key: "grass", kinds: GRASS_KINDS, cell: 50, salt: 3, margin: 24, chance: 0.9, clear: 2, open: 0, glade: 0 },
] as const;

export interface Placement {
  layer: (typeof LAYERS)[number]["key"];
  /** Species key, e.g. "tree:oak:summer". */
  key: string;
  variant: Variant;
  x: number;
  z: number;
}

export interface Valley {
  /** Village centre and the lamp's glade. */
  VC: [number, number];
  GC: [number, number];
  dVillage(x: number, z: number): number;
  houses: House[];
  /** Per column: 0 terrain, 1 yard, 2 path. */
  surface: Uint8Array;
  /** Columns near a path, where nothing grows. */
  pathNear: Uint8Array;
  inHouse(x: number, z: number, margin?: number): boolean;
  /** The settlement's surface over the terrain's, as palette slots. */
  topOverride(slots: { path: number; pathWorn: number; yard: number }): (x: number, z: number) => number;
  /**
   * Every plant and rock whose root lies in the box, widened by each layer's
   * margin: the same points in the same order whatever box asks, so a
   * chunked world and a one-off pass agree.
   */
  scatter(x0: number, z0: number, x1: number, z1: number, visit: (p: Placement) => void, margins?: boolean): void;
}

/**
 * Where the village and the lamp's glade go: the driest, flattest spots on
 * each side of the map, the village near the river. Needs only the terrain,
 * so a page can aim its camera before any model exists.
 */
export function valleySites(terrain: Terrain, span: number): { VC: [number, number]; GC: [number, number] } {
  const W = terrain.width, D = terrain.depth;
  const S = terrain.waterLevel - 1;
  const heightAt = (x: number, z: number) => terrain.heights[x + z * W];
  const VILLAGE_R = villageRadius(span);
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
  return { VC, GC };
}

export interface LayoutInput {
  terrain: Terrain;
  span: number;
  seed: number;
  season: Season;
  /** Generated models per species key (houses are measured for their footprints and doors). */
  models: Map<string, Entity[]>;
  pools: Map<string, VariantPool>;
  sites: { VC: [number, number]; GC: [number, number] };
}

/** Decide the settlement and level its pads into `terrain.heights`. */
export function layoutValley(inp: LayoutInput): Valley {
  const { terrain, span, seed, season, models, pools } = inp;
  const noise = makeNoise(seed);
  const W = terrain.width, D = terrain.depth;
  const S = terrain.waterLevel - 1; // top water voxel
  const heightAt = (x: number, z: number) => terrain.heights[x + z * W];
  const VILLAGE_R = villageRadius(span);

  const { VC, GC } = inp.sites;
  const dVillage = (x: number, z: number) => Math.hypot(x - VC[0], z - VC[1]);

  // --- houses ---------------------------------------------------------------------------
  // Sites come from a coarse jittered grid, dense in the village and rare
  // outside (a few outlying farms). Each is turned so its door faces the
  // village centre and accepted only on dry ground clear of the water and of
  // the houses already placed.

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
      const variant = Math.floor(c.rng() * list.length) % list.length;
      const entity = list[variant];
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
      houses.push({ entity, variant, orientation: best, x: c.x, z: c.z, y: 0, x0, z0, x1, z1, door: [x0 + dp[0], z0 + dp[2]], key });
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

  const topOverride = (slots: { path: number; pathWorn: number; yard: number }) => (x: number, z: number) => {
    const s = surface[x + z * W];
    if (s === 2) return noise.value2(x * 0.3, z * 0.3) > 0.55 ? slots.pathWorn : slots.path;
    if (s === 1) return slots.yard;
    return 0;
  };

  const scatter: Valley["scatter"] = (x0, z0, x1, z1, visit, margins = true) => {
    for (const layer of LAYERS) {
      const m = margins ? layer.margin : 0;
      scatterRegion({ cell: layer.cell, seed, salt: layer.salt }, x0 - m, z0 - m, x1 + m, z1 + m, (pt) => {
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
        const key = layer.key === "rock" ? `rock:${ROCKS[kind as (typeof ROCK_KINDS)[number]].species}:${kind}` : `${layer.key}:${kind}:${season}`;
        const variant = pools.get(key)!.at((pt.rng() * 1e6) | 0, pt.rng);
        visit({ layer: layer.key, key, variant, x: pt.x, z: pt.z });
      });
    }
  };

  return { VC, GC, dVillage, houses, surface, pathNear, inHouse, topOverride, scatter };
}
