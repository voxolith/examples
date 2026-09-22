// Load-time benchmark for the forest scene, headless and GPU-free.
//
// Breaks the cost of building a world into its parts so an optimisation can be
// pointed at the expensive one and measured rather than guessed.
//
//   bun run --cwd examples bench          # default 4x4
//   SPAN=2 bun run --cwd examples bench

import { seededRandom, hashSeed, BrickGrid } from "@voxolith/renderer/core";
import { blitModel, makeVariantPool, PaletteAllocator, type Entity, type Role, type VariantPool } from "@voxolith/engine";
import { makeNoise } from "@voxolith/gen-kit";
import { generateTree, PRESETS as TREES } from "@voxolith/gen-tree";
import { generateBush, PRESETS as BUSHES } from "@voxolith/gen-bush";
import { generateGrass, PRESETS as GRASSES } from "@voxolith/gen-grass";

const SPAN = Number(process.env.SPAN ?? 4);
const TILE = 320;
const AREA = SPAN * SPAN;
const SIZE = { x: TILE * SPAN, y: 176, z: TILE * SPAN };
const idx = (x: number, y: number, z: number) => x + y * SIZE.x + z * SIZE.x * SIZE.y;
const COUNTS = { trees: 14 * AREA, bushes: 22 * AREA, grass: 34 * AREA };
// 0 = the old behaviour, a freshly generated model per plant.
const VARIANTS = Number(process.env.VARIANTS ?? 12);
const pools = new Map<string, VariantPool>();
const pool = (key: string, make: (i: number) => Entity): VariantPool => {
  let p = pools.get(key);
  if (!p) { p = makeVariantPool({ count: VARIANTS, make }); pools.set(key, p); }
  return p;
};

const ms = () => performance.now();
const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${n.toFixed(0)}ms`);
const timers: Record<string, number> = {};
function time<T>(key: string, fn: () => T): T {
  const t = ms();
  const out = fn();
  timers[key] = (timers[key] ?? 0) + (ms() - t);
  return out;
}

const seed = hashSeed("voxolith");
const rng = seededRandom(seed);
const noise = makeNoise(seed);

console.log(`forest bench — ${SIZE.x}x${SIZE.y}x${SIZE.z}, ${COUNTS.trees + COUNTS.bushes + COUNTS.grass} entities\n`);

const world = time("allocate world", () => new Uint8Array(SIZE.x * SIZE.y * SIZE.z));
const palette = new PaletteAllocator(1);
const ground: Role[] = [
  { id: "ground.grass", name: "Turf", color: [0.29, 0.42, 0.21] },
  { id: "ground.grass2", name: "Turf light", color: [0.35, 0.48, 0.24] },
  { id: "ground.dirt", name: "Soil", color: [0.31, 0.24, 0.17] },
  { id: "ground.rock", name: "Rock", color: [0.42, 0.41, 0.39] },
];
const { base: gb } = palette.allocate(ground, "ground");
const BASE_Y = 10;
const height = new Int16Array(SIZE.x * SIZE.z);

time("terrain", () => {
  for (let z = 0; z < SIZE.z; z++)
    for (let x = 0; x < SIZE.x; x++)
      height[x + z * SIZE.x] = Math.max(
        3,
        BASE_Y + Math.round(noise.fbm2(x * 0.012, z * 0.012, 3) * 14 - 5) + Math.round(noise.fbm2(x * 0.05, z * 0.05, 2) * 3),
      );
  for (let z = 0; z < SIZE.z; z++)
    for (let x = 0; x < SIZE.x; x++) {
      const h = height[x + z * SIZE.x];
      for (let y = 0; y <= h; y++)
        world[idx(x, y, z)] = y === h ? (noise.value2(x * 0.3, z * 0.3) > 0.5 ? gb : gb + 1) : y > h - 3 ? gb + 2 : gb + 3;
    }
});

// Placement, as the example does it.
const CELL = 64;
const gw = Math.ceil(SIZE.x / CELL);
const gd = Math.ceil(SIZE.z / CELL);
const buckets: { x: number; z: number; r: number }[][] = Array.from({ length: gw * gd }, () => []);
const bucketAt = (x: number, z: number) =>
  buckets[Math.min(gw - 1, (x / CELL) | 0) + Math.min(gd - 1, (z / CELL) | 0) * gw];
function findSpot(radius: number, margin: number, tries = 120) {
  for (let t = 0; t < tries; t++) {
    const x = Math.round(margin + rng() * (SIZE.x - margin * 2));
    const z = Math.round(margin + rng() * (SIZE.z - margin * 2));
    const cx = Math.min(gw - 1, (x / CELL) | 0);
    const cz = Math.min(gd - 1, (z / CELL) | 0);
    let ok = true;
    for (let j = Math.max(0, cz - 1); j <= Math.min(gd - 1, cz + 1) && ok; j++)
      for (let i = Math.max(0, cx - 1); i <= Math.min(gw - 1, cx + 1) && ok; i++)
        for (const p of buckets[i + j * gw]) {
          const c = Math.max(p.r, radius);
          if ((p.x - x) ** 2 + (p.z - z) ** 2 < c * c) { ok = false; break; }
        }
    if (ok) return { x, z, r: radius };
  }
  return null;
}

let planted = 0;
let modelCells = 0;
let solidVoxels = 0;
const counted = new Map<Entity, number>();

function place(entity: Entity, key: string, x: number, z: number, o = 0 as any) {
  const { base } = time("palette", () => palette.allocateFor(entity, key));
  const m = entity.model;
  modelCells += m.size.x * m.size.y * m.size.z;
  let n = counted.get(entity);
  if (n === undefined) { n = 0; for (const b of m.data) if (b) n++; counted.set(entity, n); }
  solidVoxels += n;
  time("blit", () => blitModel({ size: SIZE, data: world }, m, { x, y: height[x + z * SIZE.x] + 1, z }, base, o));
  planted++;
}

const TK = ["oak", "birch", "spruce"] as const;
const BK = ["bush", "bramble"] as const;
const GK = ["grass", "meadow", "fern"] as const;

for (let i = 0; i < COUNTS.trees; i++) {
  const kind = TK[Math.floor(rng() * TK.length)];
  const spot = time("findSpot", () => findSpot(30, 40));
  if (!spot) continue;
  bucketAt(spot.x, spot.z).push(spot);
  const v = time("generate", () => pool(`tree:${kind}`, (n) => {
    const p = structuredClone(TREES[kind]);
    p.shape.height = Math.round(84 + (n / Math.max(1, VARIANTS)) * 40);
    p.look.season = "summer";
    p.look.age = 0.35 + (n / Math.max(1, VARIANTS)) * 0.6;
    return generateTree(p, seededRandom(seed + n * 977), `t${n}`).entity;
  }).pick(rng));
  place(v.entity, `tree:${kind}`, spot.x, spot.z, v.orientation);
}
for (let i = 0; i < COUNTS.bushes; i++) {
  const kind = BK[Math.floor(rng() * BK.length)];
  const spot = time("findSpot", () => findSpot(16, 24));
  if (!spot) continue;
  bucketAt(spot.x, spot.z).push(spot);
  const v = time("generate", () => pool(`bush:${kind}`, (n) => {
    const p = structuredClone(BUSHES[kind]);
    p.shape.height = Math.round(28 + (n / Math.max(1, VARIANTS)) * 22);
    p.look.season = "summer";
    return generateBush(p, seededRandom(seed + 5000 + n * 131), `b${n}`).entity;
  }).pick(rng));
  place(v.entity, `bush:${kind}`, spot.x, spot.z, v.orientation);
}
for (let i = 0; i < COUNTS.grass; i++) {
  const kind = GK[Math.floor(rng() * GK.length)];
  const spot = time("findSpot", () => findSpot(10, 14));
  if (!spot) continue;
  bucketAt(spot.x, spot.z).push(spot);
  const v = time("generate", () => pool(`grass:${kind}`, (n) => {
    const p = structuredClone(GRASSES[kind]);
    p.shape.height = Math.round(16 + (n / Math.max(1, VARIANTS)) * 14);
    p.look.season = "summer";
    return generateGrass(p, seededRandom(seed + 9000 + n * 71), `g${n}`).entity;
  }).pick(rng));
  place(v.entity, `grass:${kind}`, spot.x, spot.z, v.orientation);
}

const bricks = time("bricks", () => new BrickGrid(SIZE, world));

const total = Object.values(timers).reduce((a, b) => a + b, 0);
const rows = Object.entries(timers).sort((a, b) => b[1] - a[1]);
console.log("  stage             time     share");
for (const [k, v] of rows)
  console.log(`  ${k.padEnd(16)} ${fmt(v).padStart(7)}   ${((100 * v) / total).toFixed(1).padStart(5)}%`);
const built = [...pools.values()].reduce((a, p) => a + p.generated, 0);
console.log(`  ${"TOTAL".padEnd(16)} ${fmt(total).padStart(7)}`);

const st = bricks.stats();
console.log(
  `\n  ${planted} entities from ${built} generated models (variants=${VARIANTS}), ${(solidVoxels / 1e6).toFixed(1)}M solid voxels placed` +
    `\n  blit walked ${(modelCells / 1e6).toFixed(0)}M model cells for ${(solidVoxels / 1e6).toFixed(1)}M writes ` +
    `(${((100 * solidVoxels) / modelCells).toFixed(1)}% useful)` +
    `\n  bricks ${st.used}, ${(st.payloadBytes / 1048576).toFixed(1)} MB payload vs ${(st.denseBytes / 1048576).toFixed(0)} MB dense`,
);
