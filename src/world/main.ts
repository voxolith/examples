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
import { hashSeed } from "@voxolith/renderer/core";
import {
  makeChunkedWorld,
  makeVariantPool,
  PaletteAllocator,
  voxelCount,
  type Entity,
  type Role,
  type VariantPool,
} from "@voxolith/engine";
import { makeGeneratorPool } from "@voxolith/engine/worker";
import { createInput, makeOrbitController, prepareSurface, recogniseGestures } from "@voxolith/engine/input";
import {
  approach,
  atmosphereFrame,
  ATMOSPHERES,
  makeAtmosphereTransition,
  timeOfDay,
  type AtmosphereName,
} from "@voxolith/engine/atmosphere";
import { layoutValley, paletteKey, TILE, valleySites, valleySpecies, valleyTerrain, workerSeed, type Season, type Species } from "./layout";
import { boot, runLoop } from "../shared/boot";

// One tile is 320 voxels square; `scale` lays out SPANxSPAN of them.
const params = new URLSearchParams(location.search);
const SPAN = Math.max(1, Math.min(8, Math.round(Number(params.get("scale") ?? 4))));
const SIZE = { x: TILE * SPAN, y: 192, z: TILE * SPAN };

const seed = hashSeed(params.get("seed") ?? "voxolith");
const season = (params.get("season") ?? "summer") as Season;
const still = params.has("still");

const app = await boot("world");
if (app) {
  const { gpu, canvas, info } = app;

  // --- terrain --------------------------------------------------------------
  // The ground and the river come from the terrain generator; the settlement
  // (./layout.ts) edits its heights in place (levelled pads) before anything
  // is built.
  const terrain = valleyTerrain(SPAN, seed);
  const W = terrain.width, D = terrain.depth;
  const S = terrain.waterLevel - 1; // top water voxel
  const heightAt = (x: number, z: number) => terrain.heights[x + z * W];
  const sites = valleySites(terrain, SPAN);
  const { VC, GC } = sites;

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
  const useWorkers = params.get("workers") !== "0";

  const species: Species[] = valleySpecies(seed, season, VARIANTS);

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
            seed: workerSeed(seed, si, n),
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

  // --- the settlement ----------------------------------------------------------------
  // Houses, levelled pads, footpaths and what grows where: ./layout.ts, shared
  // with the 100 voxel/metre valley.
  const valley = layoutValley({ terrain, span: SPAN, seed, season, models, pools, sites });
  const { houses } = valley;
  const maxY = terrain.maxY();
  /** The settlement's surface over the terrain's: paths and yards. */
  const topOverride = valley.topOverride({ path: PATH, pathWorn: PATH2, yard: YARD });

  // --- the world --------------------------------------------------------------------------
  const counted = new Map<Entity, number>();
  const sizeOf = (e: Entity): number => {
    let n = counted.get(e);
    if (n === undefined) { n = voxelCount(e.model); counted.set(e, n); }
    return n;
  };

  const CHUNK = 64;

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

      valley.scatter(ctx.box.x0, ctx.box.z0, ctx.box.x1, ctx.box.z1, (pt) => {
        const v = pt.variant;
        ctx.blit(v.entity.model, { x: pt.x, y: heightAt(pt.x, pt.z) + 1, z: pt.z }, allocate(v.entity, pt.key), v.orientation);
        if (pt.x >= ctx.box.x0 && pt.x <= ctx.box.x1 && pt.z >= ctx.box.z0 && pt.z <= ctx.box.z1) {
          placed++;
          if (pt.layer === "rock") rocksPlaced++;
          if (pt.layer === "tree") treesPlaced++;
          voxels += sizeOf(v.entity);
        }
      });
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
