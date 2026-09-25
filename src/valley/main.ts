// valley — the world page's valley at 100 voxels per metre, a rat's-eye scale.
//
// The same valley as ../world: its terrain, river, village, footpaths and
// forest come from the same layout (../world/layout.ts), decided in the
// world page's 10 voxels per metre and multiplied by ten here. What changes
// is the resolution:
//   - every model is generated at 100 voxels per metre: the generators
//     refine their own design (single leaves and needles, bark furrows,
//     bricks, tiles and mortar at real size, rounded rock), as sparse models;
//   - models are drawn as instances, once each on the GPU however often they
//     stand in the valley, at the layout's exact orientations;
//   - the terrain is refined per brick (a smooth surface, grass blades,
//     pebbles) and streamed in chunks around the view, since a 128 m valley
//     of 1 cm voxels does not fit in memory at once;
//   - rats, at their real size, roam the village as an instanced crowd.
//
// ?scale= sets the valley size as on the world page (default 4), ?variants=
// the models per species (default 3; the world page uses 10, which matches
// it exactly but needs over a gigabyte of GPU memory), ?rats= the crowd,
// ?radius= the streamed radius in metres. Drag the lamp, N for night, W for
// weather, as on the world page.

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
  makeChunkedWorld,
  makeInstanceLayer,
  makeVariantPool,
  orientationYaw,
  PaletteAllocator,
  type Entity,
  type Role,
  type VariantPool,
} from "@voxolith/engine";
import { makeAnimator, makeCrowd, type CrowdMember } from "@voxolith/engine/animation";
import { makeGeneratorPool } from "@voxolith/engine/worker";
import { createInput, makeOrbitController, prepareSurface, recogniseGestures } from "@voxolith/engine/input";
import { approach, atmosphereFrame, ATMOSPHERES, makeAtmosphereTransition, timeOfDay, type AtmosphereName } from "@voxolith/engine/atmosphere";
import { refineTerrain } from "@voxolith/gen-terrain";
import { generateBuilding } from "@voxolith/gen-building";
import { atScale, generateCreature, PRESETS as RATS } from "@voxolith/gen-creature";
import { houseParams, HOUSE_KINDS, layoutValley, paletteKey, TILE, valleySites, valleySpecies, valleyTerrain, workerSeed, type Season } from "../world/layout";
import { boot, runLoop } from "../shared/boot";

const params = new URLSearchParams(location.search);
/** Voxels per metre here, and the factor over the world page's 10. */
const VPM = 100;
const K = VPM / 10;
const SPAN = Math.max(1, Math.min(8, Math.round(Number(params.get("scale") ?? 4))));
const COARSE = { x: TILE * SPAN, y: 192, z: TILE * SPAN };
const SIZE = { x: COARSE.x * K, y: COARSE.y * K, z: COARSE.z * K };
const VARIANTS = Math.max(1, Math.min(10, Number(params.get("variants") ?? 3)));
const RAT_COUNT = Math.max(0, Math.min(400, Number(params.get("rats") ?? 60)));
/** Streamed radius, fine voxels. */
const RADIUS = Math.max(8, Number(params.get("radius") ?? 24)) * VPM;
const seed = hashSeed(params.get("seed") ?? "voxolith");
const season = (params.get("season") ?? "summer") as Season;

const app = await boot("valley");
if (app) {
  const { gpu, canvas, info } = app;

  // --- the valley's design, at the world page's scale ------------------------------
  const terrain = valleyTerrain(SPAN, seed);
  const sites = valleySites(terrain, SPAN);
  const species = valleySpecies(seed, season, VARIANTS);

  // Houses are measured by the layout (footprint, door), so their coarse
  // models are made here too; they are quick. Same seeds as the workers use.
  info.textContent = "laying out the valley";
  const models = new Map<string, Entity[]>();
  const pools = new Map<string, VariantPool>();
  species.forEach((sp, si) => {
    if (!sp.key.startsWith("house:")) return;
    const kind = sp.key.split(":")[1] as (typeof HOUSE_KINDS)[number];
    models.set(sp.key, Array.from({ length: sp.count }, (_, n) => generateBuilding(houseParams(kind, n), seededRandom(workerSeed(seed, si, n))).entity));
  });
  // The scatter only needs a variant's index and orientation; the entity it
  // hands back is replaced by the fine model below.
  for (const sp of species) pools.set(sp.key, makeVariantPool({ count: sp.count, make: () => null as unknown as Entity }));
  const valley = layoutValley({ terrain, span: SPAN, seed, season, models, pools, sites });

  // --- palette ----------------------------------------------------------------------
  const palette = new PaletteAllocator(1);
  const { base: terrainBase } = palette.allocate(terrain.roles, "terrain");
  const settlement: Role[] = [
    { id: "path", name: "Path", color: [0.46, 0.38, 0.27] },
    { id: "path.worn", name: "Path worn", color: [0.53, 0.46, 0.34] },
    { id: "yard", name: "Trodden turf", color: [0.36, 0.42, 0.24] },
  ];
  const { base: s0 } = palette.allocate(settlement, "settlement");
  const topOverride = valley.topOverride({ path: s0, pathWorn: s0 + 1, yard: s0 + 2 });

  // --- the fine models, on workers ------------------------------------------------------
  const fine = new Map<string, Entity[]>();
  {
    const workers = makeGeneratorPool({ spawn: () => new Worker(new URL("../world/gen.worker.ts", import.meta.url), { type: "module" }) });
    await workers.ready();
    const specs = species.flatMap((sp, si) =>
      Array.from({ length: sp.count }, (_, n) => ({ generator: sp.generator, params: sp.params(n), seed: workerSeed(seed, si, n), entityId: `${sp.key}-${n}`, ctx: { voxelsPerMetre: VPM } })),
    );
    const t0 = performance.now();
    const out = await workers.generateMany(specs, (done, total) => {
      info.textContent = `generating ${done}/${total} models at ${VPM} voxels per metre`;
    });
    workers.destroy();
    let i = 0;
    for (const sp of species) { fine.set(sp.key, out.slice(i, i + sp.count)); i += sp.count; }
    console.log(`[valley] ${out.length} models in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  }
  // A palette range per species that actually appears (rocks sharing a skin
  // share one), as on the world page: 255 slots do not fit every species.
  const bases = new Map<string, number>();
  const baseOf = (key: string) => {
    let b = bases.get(key);
    if (b === undefined) bases.set(key, (b = palette.allocateFor(fine.get(key)![0], paletteKey(key)).base));
    return b;
  };
  const rats = ["rat", "grey rat"].map((k, i) => generateCreature(atScale(RATS[k], VPM), seededRandom(seed + i * 97), k).entity);
  const ratBase = rats.map((e, i) => palette.allocate(e.model.roles, `rat${i}`).base);

  // --- renderer ---------------------------------------------------------------------
  const renderer: Renderer = await createRenderer(gpu, { size: SIZE, palette: palette.buildPalette(), materials: palette.buildMaterials() });
  renderer.setClipBounds([0, 0, 0], [SIZE.x - 1, SIZE.y - 1, SIZE.z - 1]);
  const quality = gpu.software ? "low" : "medium";
  // Rays cross thousands of voxels of air here; the 64-voxel skip keeps
  // that cheap, but the step caps have to allow for the canopy and the ground.
  renderer.setQuality({ ...QUALITY_PRESETS[quality], maxSteps: gpu.software ? 768 : 2048, shadowSteps: quality === "low" ? 0 : 320 });
  // A CPU adapter would take many seconds over the first full-size frame
  // before the scale controller reacts, so it starts small.
  if (gpu.software) gpu.renderScale = Math.min(gpu.renderScale, 0.3);

  const ground = refineTerrain(terrain, K, { seed });
  const layer = makeInstanceLayer(renderer);

  // Scenery: every house and every plant and rock of the layout, placed where
  // the world page stamps it, turned the same way.
  const statics: { model: Entity["model"]; x: number; y: number; z: number; yaw: number; mirror: boolean; base: number }[] = [];
  let trees = 0, rocks = 0, plants = 0;
  for (const h of valley.houses) {
    const e = fine.get(h.key)![h.variant % fine.get(h.key)!.length];
    const { yaw, mirror } = orientationYaw(h.orientation);
    statics.push({ model: e.model, x: h.x * K, y: h.y * K, z: h.z * K, yaw, mirror, base: baseOf(h.key) });
  }
  valley.scatter(0, 0, COARSE.x - 1, COARSE.z - 1, (pt) => {
    const list = fine.get(pt.key)!;
    const e = list[pt.variant.index % list.length];
    const { yaw, mirror } = orientationYaw(pt.variant.orientation);
    const x = pt.x * K, z = pt.z * K;
    statics.push({ model: e.model, x, y: ground.heightAt(x + K / 2, z + K / 2) + 1, z, yaw, mirror, base: baseOf(pt.key) });
    if (pt.layer === "tree") trees++;
    else if (pt.layer === "rock") rocks++;
    else plants++;
  }, false);
  layer.setStatic(statics);
  // Ranges were claimed while placing; send the finished palette.
  renderer.updatePalette(palette.buildPalette());
  const mats = palette.buildMaterials();
  if (mats) renderer.updateMaterials(mats);

  // --- the ground, streamed ---------------------------------------------------------------
  const CHUNK = 256;
  const world = makeChunkedWorld({
    target: renderer,
    size: SIZE,
    chunk: CHUNK,
    seed,
    generate(ctx) {
      // A box per 8x8 brick column, sized to what the column holds: the
      // fine terrain answers a column's bricks in a run.
      const boxes = [];
      for (let oz = ctx.box.z0; oz <= ctx.box.z1; oz += 8)
        for (let ox = ctx.box.x0; ox <= ctx.box.x1; ox += 8) {
          const [y0, y1] = ground.columnSpan(ox, oz);
          boxes.push({ x0: ox, y0, z0: oz, x1: ox + 7, y1, z1: oz + 7 });
        }
      renderer.editMany(boxes, (cells, ox, oy, oz) => ground.fillBrick(cells, ox, oy, oz, terrainBase, topOverride));
    },
  });

  // --- rats ---------------------------------------------------------------------------------
  interface Rat extends CrowdMember { speed: number; turn: number; timer: number; }
  const crowd = makeCrowd({ instances: layer, near: 3000, farFps: 6, freeze: 12000, budgetMs: 4 });
  const rng = seededRandom(seed ^ 0x51ed);
  const [vx, vz] = [sites.VC[0] * K, sites.VC[1] * K];
  const members: Rat[] = [];
  for (let i = 0; i < RAT_COUNT; i++) {
    const k = i % rats.length;
    const anim = makeAnimator(rats[k], "walk");
    anim.update(rng() * 3);
    let x = 0, z = 0;
    for (let t = 0; t < 50; t++) {
      x = vx + (rng() - 0.5) * 3000; z = vz + (rng() - 0.5) * 3000;
      if (!ground.waterAt(x, z) && !valley.inHouse(Math.floor(x / K), Math.floor(z / K), 2)) break;
    }
    members.push({ id: i + 1, entity: rats[k], variant: `rat${k}`, anim, base: ratBase[k], x, y: 0, z, yaw: rng() * Math.PI * 2, speed: 40, turn: 0, timer: rng() * 4 });
  }
  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  const blocked = (x: number, z: number) =>
    x < 50 || z < 50 || x > SIZE.x - 50 || z > SIZE.z - 50 || ground.waterAt(x, z) || valley.inHouse(Math.floor(x / K), Math.floor(z / K), 1);
  const think = (r: Rat, dt: number) => {
    r.timer -= dt;
    if (r.timer <= 0) {
      const c = ["walk", "walk", "idle", "sniff", "run"][Math.floor(rng() * 5)];
      r.anim.play(c, { fade: 0.25 });
      // Real rat speeds: about half a metre a second walking, two running.
      r.speed = c === "walk" ? 45 : c === "run" ? 180 : 0;
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
  const night0 = params.get("time") === "night";
  const camera = makeCamera({ target: [vx, 0, vz], distance: 2600, pitchDeg: 38, fovDeg: 42 });
  prepareSurface(canvas, { contextMenu: false });
  const input = createInput(canvas, { loop: { invalidate: () => loop.invalidate() } });
  const start: [number, number] = night0 ? [sites.GC[0] * K, sites.GC[1] * K] : [vx, vz];
  const orbit = makeOrbitController(input, {
    yaw: 35, pitchLimits: [8, 85], distanceLimits: [150, RADIUS * 0.8], fovDeg: 42, pan: "secondary",
    onChange: () => perf.reprobe(),
    panBounds: { minX: 0, maxX: SIZE.x, minZ: 0, maxZ: SIZE.z },
    target: [start[0], ground.heightAt(start[0], start[1]) + 60, start[1]],
    pitch: night0 ? 45 : 38,
    distance: night0 ? 1800 : 2600,
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

  const HOVER = 70;
  const lamp: Vec3 = [sites.GC[0] * K, 0, sites.GC[1] * K];
  const standAt = (x: number, z: number) => Math.max(ground.heightAt(x, z), ground.waterAt(x, z) ? ground.waterTop : 0) + HOVER;
  lamp[1] = standAt(lamp[0], lamp[2]);
  const updateLamp = () => {
    const lights: PointLight[] = [
      { position: lamp, color: [1.0, 0.7, 0.38], intensity: 2.6, range: 900, glow: 35 },
      { position: lamp, color: [1.0, 0.75, 0.45], intensity: 0.25, range: 500, shadows: false },
    ];
    renderer.setLights(lights);
    loop.invalidate();
  };

  // A light haze, whatever the weather, so the streamed edge at the horizon
  // softens; the zoom limit keeps the camera well inside it.
  const edgeFog = 0.1 / RADIUS;
  let spin = true;
  let last = performance.now();
  const loop = runLoop((now, dt) => {
    const step = Math.min(0.05, (now - last) / 1000);
    last = now;
    stream();
    for (const r of members) think(r, step);
    const f = frame();
    if (members.length) crowd.update(members, f.camPos as [number, number, number]);
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
    if (world.pending) world.step(6);
  }
  world.focus(orbit.target()[0], orbit.target()[2], RADIUS, RADIUS * 1.3);
  focusX = orbit.target()[0]; focusZ = orbit.target()[2];
  const total = world.pending;
  // Build the middle of the view before showing the page, the rest streams in.
  while (world.pending > total * 0.6) {
    world.step(40);
    info.textContent = `building the ground ${total - world.pending}/${total} chunks`;
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  }

  const acc = { frames: 0, t: performance.now() };
  const report = () => {
    const now = performance.now(), secs = (now - acc.t) / 1000, st = renderer.instanceStats();
    info.textContent =
      `${valley.houses.length} houses, ${trees} trees, ${rocks} rocks, ${plants} plants, ${members.length} rats · ` +
      `${st.instances} instances of ${st.models} models · ${world.resident} chunks${world.pending ? ` (+${world.pending})` : ""} · ` +
      `${(st.bytes / 1048576).toFixed(0)} MB on the GPU · ${(acc.frames / secs).toFixed(0)} fps · drag the lamp · N night/day · W weather`;
    acc.frames = 0; acc.t = now;
  };
  const countFrames = () => { acc.frames++; requestAnimationFrame(countFrames); };
  requestAnimationFrame(countFrames);
  setInterval(report, 1000);
  report();

  if (params.has("e2e")) {
    Object.assign(window, {
      valleyStats: () => ({ ...renderer.instanceStats(), houses: valley.houses.length, trees, rocks, plants, rats: members.length, resident: world.resident, pending: world.pending, first: members[0] ? { x: members[0].x, z: members[0].z } : null, ratSum: members.reduce((n, r) => n + r.x + r.z, 0) }),
      valleyPlaces: { village: [vx, vz], glade: [sites.GC[0] * K, sites.GC[1] * K], get rat() { return members[0] ? [members[0].x, members[0].z] : [vx, vz]; } },
      valleyLook: (x: number, z: number, distance: number, pitch: number, yaw?: number) => {
        spin = false;
        orbit.set({ target: [x, ground.heightAt(x, z) + 60, z], distance, pitch, ...(yaw === undefined ? {} : { yaw }) });
      },
      valleyWeather: (name: AtmosphereName) => setWeather(name, 0),
      valleyLamp: () => lampOnScreen(),
    });
  }
}
