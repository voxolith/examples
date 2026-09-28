// nightwood — standing in a forest clearing at night, at 20, 50 or 100 voxels per metre.
//
// A dense wood of oak, birch and spruce with bushes, bracken and grass underneath, lit by the
// moon; through a gap in the trees a cottage with its windows lit and a lantern by the door; and
// fireflies drifting between the trunks. You can look around (drag, mouse after a click, touch,
// a gamepad's right stick, or Q/E/R/F) but not walk: the camera stands still, so the world only
// has to reach as far as the fog lets you see, and every ray stops within about 30 m.
//
// The lighting is the point of the page. Today it is the key light (the moon), the renderer's
// point lights (the lantern, and one per firefly, unshadowed, with a halo) and the emissive
// window glass, which lights only itself; the renderer's roadmap (temporal accumulation, then a
// world-space radiance cache) is measured against this page.
//
// Models are generated at 50 voxels per metre (2 cm) on a desktop and 20 (5 cm) on a phone (a
// touch-only pointer, or storage bindings under 512 MiB); the HUD's button reloads one scale finer
// (100 or 50), or back. They are made on workers (the world page's generator worker, with its model
// cache in production builds) and drawn as instances; the ground is refined per brick column
// around the clearing. Phones also get fewer fireflies and a lighter preset. Every length is in
// metres, so the scene is the same at every scale. URL options:
//   ?vpm=20|50|100 (default 50, 20 on a phone; anything else snaps to the nearest), ?fireflies=
//   (up to 28), ?seed=, ?full (desktop settings on a phone),
//   ?weather= (any ATMOSPHERES name, default fog; clear for no mist), ?mist= (its thickness,
//   default 0.8), ?view= (the view distance in metres, default 24), ?trees=, ?shrubs=, ?plants=
//   (densities, 0-1), ?renderScale= (a fixed render scale instead of the adaptive one), ?perf (the
//   overlay, and the load timeline in the console).

import { createRenderer, firstPersonFrame, makePerf, observeResize, QUALITY_PRESETS, resizeToDisplay, type PointLight, type Renderer, type Vec3 } from "@voxolith/renderer";
import { hashSeed, seededRandom } from "@voxolith/renderer/core";
import { makeChunkedWorld, makeInstanceLayer, PaletteAllocator, trackRenderer, type Entity, type RGB } from "@voxolith/engine";
import { makeGeneratorPool } from "@voxolith/engine/worker";
import { createInput, makeLookController, prepareSurface } from "@voxolith/engine/input";
import { atmosphereFrame, ATMOSPHERES, timeOfDay } from "@voxolith/engine/atmosphere";
import { generateTerrain, refineTerrain } from "@voxolith/gen-terrain";
import { PRESETS as TREES } from "@voxolith/gen-tree";
import { PRESETS as BUSHES } from "@voxolith/gen-bush";
import { PRESETS as GRASSES } from "@voxolith/gen-grass";
import { PRESETS as BUILDINGS } from "@voxolith/gen-building";
import { boot, runLoop } from "../shared/boot";
import { nextFrame, prepared, reportLoadTimeline, step } from "../shared/loading";
import { commitStatic, placementWorker } from "../shared/placement";
import { STEPS } from "../shared/loading-screen";
import { isPhone, pickScale, voxelSize } from "../shared/scale";

const params = new URLSearchParams(location.search);
const seed = hashSeed(params.get("seed") ?? "nightwood");
const num = (key: string, fallback: number) => (params.has(key) ? Number(params.get(key)) : fallback);

// The loading screen's rows, in this order (phases not listed are not shown, but stay on the
// tracker for window.loadTimeline and ?perf).
const app = await boot("nightwood", {
  blurb: "A forest clearing at night",
  steps: [
    STEPS.device,
    STEPS.models,
    STEPS.shaders,
    STEPS.pipelines,
    STEPS.upload,
    STEPS.placement,
    STEPS.ground,
  ],
});
if (app) {
  const { gpu, canvas, info, load, screen } = app;
  // One tracker for the whole load (boot's: workers, renderer, instance layer, ground); the
  // loading screen shows it until the clearing is up.
  // A phone: touch-only pointer or the small storage bindings mobile GPUs offer (as the valley).
  const phone = isPhone(gpu, params);
  // 50 voxels per metre (2 cm) by default, 20 (5 cm) on a phone; the HUD's scale button reloads one
  // scale finer, or back (?vpm=), since every model is generated for its scale.
  const VPM = pickScale(params, phone);
  const title = document.querySelector("#hud .brand small");
  if (title) title.textContent = `nightwood · ${voxelSize(VPM)} voxels`;
  /** Metres to voxels at this resolution. */
  const m = (metres: number) => metres * VPM;
  const K = VPM / 10;
  // Density knobs, 0-1 (for measuring what the scene costs): ?trees=, ?shrubs=, ?plants=.
  const DENSITY = { trees: num("trees", 1), shrubs: num("shrubs", 1), plants: num("plants", 1) };
  const FIXED_SCALE = num("renderScale", 0);
  /** How thick the weather's fog is, times the engine's (?mist=). */
  const MIST = Math.max(0, num("mist", 0.8));
  /** View distance, metres: the fog wall, and how far any ray goes. */
  const VIEW = Math.max(8, Math.min(40, num("view", 24)));
  const FIREFLIES = Math.max(0, Math.min(28, num("fireflies", phone ? 12 : 24)));

  // --- the design, at 10 voxels per metre ------------------------------------------------------
  // A 60 m square of gently rolling forest floor, no water, 24 m of air for the tallest spruce; the
  // clearing in the middle.
  const COARSE = { x: 600, y: 240, z: 600 };
  const terrain = generateTerrain(
    { width: COARSE.x, depth: COARSE.z, height: COARSE.y, baseY: 30, relief: 5, featureSize: 220, waterLevel: 0, river: { enabled: false, width: 0, depth: 0, banks: 0, meander: 100 } },
    seed,
  );
  const SIZE = { x: COARSE.x * K, y: COARSE.y * K, z: COARSE.z * K };
  const C: [number, number] = [SIZE.x / 2, SIZE.z / 2];
  // The cottage stands 17 m out, seen through a gap in the trees.
  const HOUSE_DIR = 0.6;
  const H: [number, number] = [C[0] + Math.sin(HOUSE_DIR) * m(17), C[1] + Math.cos(HOUSE_DIR) * m(17)];

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
  const cottage = structuredClone(BUILDINGS.cottage);
  cottage.look.lit = 1;
  const KINDS = {
    trees: [tree("oak", 170, 0.8, 0), tree("oak", 140, 0.6, 1), tree("birch", 150, 0.5, 2), tree("spruce", 190, 0.7, 3), tree("spruce", 150, 0.5, 4)],
    bushes: [bush("bush", 14, 0), bush("thicket", 18, 1), bush("bramble", 10, 2)],
    ground: [grass("fern", 7, 0), grass("meadow", 4, 1), grass("grass", 4, 2)],
    house: { key: "house", generator: "voxolith/house", params: cottage, seed: seed + 20000 } as Kind,
  };
  const all = [...KINDS.trees, ...KINDS.bushes, ...KINDS.ground, KINDS.house];

  const fine = new Map<string, Entity>();
  {
    const workers = makeGeneratorPool({ spawn: () => new Worker(new URL("../world/gen.worker.ts", import.meta.url), { type: "module" }), load });
    await workers.ready();
    const out = await workers.generateMany(
      all.map((k) => ({ generator: k.generator, params: k.params, seed: k.seed, entityId: k.key, ctx: { voxelsPerMetre: VPM } })),
    );
    // Not awaited: it only lets the workers finish their cache writes.
    void workers.destroy();
    all.forEach((k, i) => fine.set(k.key, out[i]));
  }

  // --- renderer ------------------------------------------------------------------------------------
  const palette = new PaletteAllocator(1);
  const { base: groundBase } = palette.allocate(terrain.roles, "terrain");
  const renderer: Renderer = await createRenderer(gpu, { size: SIZE, palette: palette.buildPalette(), materials: palette.buildMaterials() }, { onLoad: trackRenderer(load), deferPipelines: true });
  renderer.setClipBounds([0, 0, 0], [SIZE.x - 1, SIZE.y - 1, SIZE.z - 1]);
  const quality = gpu.software ? "low" : phone ? "medium" : "high";
  // The view distance bounds every primary ray (about 1.7 steps per voxel of it at worst).
  renderer.setQuality({ ...QUALITY_PRESETS[quality], maxSteps: gpu.software ? 768 : 1024, shadowSteps: quality === "low" ? 0 : 128 });
  if (gpu.software) gpu.renderScale = Math.min(gpu.renderScale, 0.3);
  else if (phone) gpu.renderScale = Math.min(gpu.renderScale, 0.6);
  // deferPipelines above: compile what the frames use (instances: the wood is not placed yet)
  // while the wood is placed and the ground built, and await it before the first frame.
  const compiled = prepared(renderer.prepare({ instances: true }));

  const ground = refineTerrain(terrain, K, { seed });
  const floor = (x: number, z: number) => ground.heightAt(Math.max(0, Math.min(SIZE.x - 1, x)), Math.max(0, Math.min(SIZE.z - 1, z)));
  // The wood's static set is baked on a worker (commitAsync below), so the page keeps painting.
  const placement = placementWorker();
  const layer = makeInstanceLayer(renderer, { load, placement });
  // A darker, cooler night skin for the foliage: the moon does not show greens as the sun does.
  const night = (c: RGB): RGB => [c[0] * 0.8, c[1] * 0.85, c[2] * 0.95];
  const baseOf = (key: string) => layer.palettes.of(key, fine.get(key)!.model.roles, key === "house" ? undefined : night);

  // --- the wood ----------------------------------------------------------------------------------
  const rng = seededRandom(seed ^ 0x77);
  const statics: { model: Entity["model"]; x: number; y: number; z: number; yaw: number; base: number }[] = [];
  const place = (key: string, x: number, z: number) => {
    const e = fine.get(key)!;
    statics.push({ model: e.model, x: Math.round(x), y: floor(x, z) + 1, z: Math.round(z), yaw: rng() * Math.PI * 2, base: baseOf(key) });
  };
  const angle = (x: number, z: number) => Math.atan2(x - C[0], z - C[1]);
  const inGap = (x: number, z: number) => {
    // The view to the cottage: a narrowing wedge of open ground towards it, and the house site.
    const d = Math.abs(Math.atan2(Math.sin(angle(x, z) - HOUSE_DIR), Math.cos(angle(x, z) - HOUSE_DIR)));
    return d < 0.14 || Math.hypot(x - H[0], z - H[1]) < m(6);
  };
  const ring = (r: number, r0: number, r1: number) => r >= r0 && r <= r1;
  let trees = 0, shrubs = 0, plants = 0;
  // Trees on a jittered 3 m grid from 8 m out; denser, taller growth further in.
  for (let gz = 0; gz < SIZE.z; gz += m(3))
    for (let gx = 0; gx < SIZE.x; gx += m(3)) {
      const x = gx + (rng() - 0.5) * m(2.4), z = gz + (rng() - 0.5) * m(2.4);
      const r = Math.hypot(x - C[0], z - C[1]);
      if (!ring(r, m(8), m(31)) || inGap(x, z) || rng() > (0.7 + (r / m(31)) * 0.25) * DENSITY.trees) continue;
      const kind = KINDS.trees[Math.floor(rng() * KINDS.trees.length)];
      place(kind.key, x, z);
      trees++;
    }
  // Shrubs from the clearing's edge into the wood.
  for (let i = 0; i < 900 * DENSITY.shrubs; i++) {
    const a = rng() * Math.PI * 2, r = m(5.5) + Math.sqrt(rng()) * m(26);
    const x = C[0] + Math.sin(a) * r, z = C[1] + Math.cos(a) * r;
    if (inGap(x, z)) continue;
    place(KINDS.bushes[Math.floor(rng() * KINDS.bushes.length)].key, x, z);
    shrubs++;
  }
  // Bracken and grass on the clearing floor and under the trees.
  for (let i = 0; i < 900 * DENSITY.plants; i++) {
    const a = rng() * Math.PI * 2, r = m(1.2) + Math.sqrt(rng()) * m(20);
    const x = C[0] + Math.sin(a) * r, z = C[1] + Math.cos(a) * r;
    place(KINDS.ground[r < m(7) ? 1 + Math.floor(rng() * 2) : Math.floor(rng() * KINDS.ground.length)].key, x, z);
    plants++;
  }
  // The cottage, its front towards the clearing.
  const house = fine.get("house")!;
  statics.push({ model: house.model, x: Math.round(H[0]), y: floor(H[0], H[1]) + 1, z: Math.round(H[1]), yaw: HOUSE_DIR + Math.PI, base: baseOf("house") });
  // Uploading the models (the engine's "upload") blocks the main thread, so its row is opened and
  // painted first. Indexing the instances ("placement") runs on the worker while the ground is
  // built below; the first frame waits for both.
  await step(load, STEPS.upload.phase, () => layer.setStatic(statics));
  const placed = commitStatic(layer).finally(() => placement.destroy());

  // --- the ground, around the clearing as far as the fog reaches -------------------------------
  const CHUNK = 256;
  const world = makeChunkedWorld({
    target: renderer,
    size: SIZE,
    chunk: CHUNK,
    seed,
    load,
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
  const REACH = m(32);
  world.focus(C[0], C[1], REACH, REACH * 1.2);
  while (world.pending) {
    world.step(40);
    await nextFrame();
  }
  await Promise.all([placed, compiled]);

  // --- lights --------------------------------------------------------------------------------------
  // The lantern by the cottage door, and the fireflies: each a small, unshadowed light with a halo,
  // drifting on its own slow path between the trunks and pulsing.
  const lantern: Vec3 = [H[0] - Math.sin(HOUSE_DIR) * m(4.2), floor(H[0], H[1]) + m(1.8), H[1] - Math.cos(HOUSE_DIR) * m(4.2)];
  interface Fly { home: Vec3; phase: number[]; rate: number[]; blink: number }
  const flies: Fly[] = Array.from({ length: FIREFLIES }, () => {
    const a = rng() * Math.PI * 2, r = m(2) + Math.sqrt(rng()) * m(15);
    const x = C[0] + Math.sin(a) * r, z = C[1] + Math.cos(a) * r;
    return {
      home: [x, floor(x, z) + m(0.4 + rng() * 1.8), z],
      phase: [rng() * 6.28, rng() * 6.28, rng() * 6.28, rng() * 6.28],
      rate: [0.13 + rng() * 0.2, 0.11 + rng() * 0.2, 0.17 + rng() * 0.25, 0.5 + rng() * 0.6],
      blink: rng() * 10,
    };
  });
  // Wander within about a metre and a half of home; blink in slow pulses with dark gaps.
  const wander = (f: Fly, t: number): Vec3 => [
    f.home[0] + Math.sin(t * f.rate[0] + f.phase[0]) * m(1.5) + Math.sin(t * f.rate[3] + f.phase[3]) * m(0.25),
    f.home[1] + Math.sin(t * f.rate[1] + f.phase[1]) * m(0.5),
    f.home[2] + Math.sin(t * f.rate[2] + f.phase[2]) * m(1.5),
  ];
  const pulse = (f: Fly, t: number) => Math.max(0, Math.sin(t * 1.3 + f.blink)) ** 3;
  const lights = (t: number): PointLight[] => [
    { position: lantern, color: [1.0, 0.66, 0.34], intensity: 2.4, range: m(11), glow: m(0.12) },
    ...flies
      .filter((f) => pulse(f, t) > 0.02)
      .map((f): PointLight => ({
        position: wander(f, t),
        color: [0.78, 1.0, 0.36],
        intensity: 0.9 * pulse(f, t),
        range: m(2.2),
        shadows: false,
        glow: m(0.035),
      })),
  ];

  // --- camera: stand in the clearing and look around ----------------------------------------
  const eye: Vec3 = [C[0], floor(C[0], C[1]) + m(1.65), C[1]];
  prepareSurface(canvas, { contextMenu: false });
  const input = createInput(canvas, { loop: { invalidate: () => loop.invalidate() } });
  // Facing the cottage to start (the look yaw turns right as it grows, from +z).
  const look = makeLookController(input, { yaw: (HOUSE_DIR * 180) / Math.PI, pitch: 2, keys: { left: ["KeyQ"], right: ["KeyE"], up: ["KeyR"], down: ["KeyF"] } });
  const perf = makePerf({ enabled: params.has("perf"), scale: gpu.renderScale, minScale: gpu.software ? 0.25 : 0.35, retryAfterMs: Infinity, gpuTimings: () => renderer.gpuTimings() });

  // Night: the moon as the key light, a little brighter and bluer than the default night. The
  // weather (?weather=, default fog) is the engine's; its fog is recoloured to moonlit mist, since
  // the night horizon it would take is almost black and reads as darkness, not mist.
  const moon = timeOfDay(0.98);
  moon.lightColor = [moon.lightColor[0] * 2.2, moon.lightColor[1] * 2.5, moon.lightColor[2] * 3];
  moon.ambientSky = moon.ambientSky.map((c) => c * 2) as Vec3;
  moon.ambientGround = moon.ambientGround.map((c) => c * 2) as Vec3;
  const weather = ATMOSPHERES[params.get("weather") as keyof typeof ATMOSPHERES] ?? ATMOSPHERES.fog;
  const atm = atmosphereFrame(moon, weather, { voxelsPerMetre: VPM });
  // Rays stop at the view distance (fog.distance), where the fog closes: past it nothing is traced.
  const fog = atm.fog
    ? { ...atm.fog, density: atm.fog.density * MIST, color: [0.095, 0.11, 0.14] as Vec3, distance: m(VIEW) }
    : { density: 1.2 / m(30), color: [0.025, 0.035, 0.06] as Vec3, heightFalloff: 0, distance: m(VIEW) };

  let last = performance.now();
  const t0 = performance.now();
  const loop = runLoop((now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    look.update(dt);
    const t = (now - t0) / 1000;
    renderer.setLights(lights(t));
    perf.frame(now);
    gpu.renderScale = FIXED_SCALE || perf.scale();
    resizeToDisplay(gpu);
    renderer.render({ ...firstPersonFrame(eye, look.yaw(), look.pitch(), 68), ...atm, fog, time: t });
  }, true);
  observeResize(canvas, loop);
  screen.ready();
  info.textContent =
    `${VPM} voxels/m${phone ? " (phone settings; ?full for all)" : ""} · ${trees} trees, ${shrubs} shrubs, ${plants} plants, ${FIREFLIES} fireflies · ` +
    "drag or click to look around (Q/E/R/F)";
  void reportLoadTimeline(load, { perf: params.has("perf"), overlay: perf });
  if (params.has("e2e")) Object.assign(window, { nightwood: { look: () => [look.yaw(), look.pitch()], flies: () => lights((performance.now() - t0) / 1000).length } });
}
