// chase — a camera that follows something that moves: `chaseFrame`.
//
// A rat on a small patch of ground. Steer it with WASD or the arrow keys, a
// gamepad's left stick, or the on-screen stick a touch screen gets; Shift (or
// the Run button) runs. Until you do, it wanders by itself.
//
// `chaseFrame(target, { yawDeg, distance, height, lookAhead, fovDeg })` puts
// the eye `distance` behind and `height` above the target along its heading,
// and looks at a point `lookAhead` in front of it: the framing of a driving or
// third-person game. It is plain arithmetic that returns the same camera
// fields `makeCamera` and `firstPersonFrame` do. The View select switches
// between four framings (the "rat's eye" one is a negative distance: the eye
// ahead of the target, at head height), and the Options panel has each number.
//
// The one thing the page adds is lag: the camera's heading eases towards the
// rat's (`?follow=`) instead of copying it, so a turn swings the rat across
// the picture before the view comes round.
//
// The rat is the creature example's: a rigged entity, animated by a crowd of
// one drawn as an instance. All input comes through `makeActions`, which binds
// keys, pad and touch to the same two axes.
//
// URL options (declared below; the HUD's Options panel changes them, all but the seed at once):
//   ?view=chase          chase | close | high | eye: a preset of the four numbers below
//   ?distance=120        how far behind the rat the eye sits, in voxels (negative: ahead of it)
//   ?height=50           how far above it
//   ?lookAhead=40        how far in front of the rat the camera looks
//   ?fov=55              the vertical field of view in degrees
//   ?follow=3            how quickly the camera's heading catches up with the rat's (0: never turns)
//   ?wander=0            start with the rat standing still instead of wandering
//   ?seed=               the scene's seed
//   ?quality=, ?temporal=1, ?upscale=, ?reflections=0, ?renderScale=, ?debug=   the renderer's own
//   ?perf, ?full                                 the frame rate (and a phone's traced fraction); a phone gets the phone
//                                                profile (../shared/quality.ts), ?full the desktop settings
//   ?e2e                 window.chaseStats() for the test tools

import { chaseFrame, createRenderer, resizeToDisplay, type Vec3 } from "@voxolith/renderer";
import { hashSeed, seededRandom } from "@voxolith/renderer/core";
import { blitModelToBricks, makeInstanceLayer, PaletteAllocator, trackRenderer, type Entity } from "@voxolith/engine";
import { makeAnimator, makeCrowd, type CrowdMember } from "@voxolith/engine/animation";
import { axis, button, createInput, makeActions, makeTouchControls, prepareSurface } from "@voxolith/engine/input";
import { classicSky } from "@voxolith/engine/atmosphere";
import { generateTerrain } from "@voxolith/gen-terrain";
import { generateTree, PRESETS as TREES } from "@voxolith/gen-tree";
import { generateRock, PRESETS as ROCKS } from "@voxolith/gen-rock";
import { generateCreature, PRESETS as RATS } from "@voxolith/gen-creature";
import { boot, runLoop } from "../shared/boot";
import { markFrames, nextFrame, prepared, reportLoadTimeline, step } from "../shared/loading";
import { STEPS } from "../shared/loading-screen";
import { defineOptions, OPTION, RENDER_OPTIONS, seedOption } from "../shared/options";
import { phoneProfile } from "../shared/scale";
import { applyRenderOptions } from "../shared/quality";
import { DAYLIGHT } from "../shared/env";

/** The View select's framings, in voxels. The rat is 75 voxels from nose to tail tip. */
const VIEWS = {
  chase: { distance: 120, height: 50, lookAhead: 40 },
  close: { distance: 70, height: 24, lookAhead: 60 },
  high: { distance: 150, height: 190, lookAhead: 10 },
  // A negative distance puts the eye ahead of the target: here at the rat's head, looking on.
  eye: { distance: -34, height: 20, lookAhead: 200 },
} as const;
type View = keyof typeof VIEWS;
const options = defineOptions({
  view: { kind: "choice", label: "View", help: "A preset of distance, height and look-ahead: behind the rat, close, from high up, or from its own eyes.", values: ["chase", "close", "high", "eye"], default: "chase", live: true, format: (v: string) => (v === "eye" ? "Rat's eye" : v[0].toUpperCase() + v.slice(1)) },
  distance: { kind: "number", label: "Distance", help: "How far behind the rat the eye sits, in voxels; negative puts it ahead.", min: -60, max: 300, step: 10, default: VIEWS.chase.distance, live: true },
  height: { kind: "number", label: "Height", help: "How far above the rat the eye sits, in voxels.", min: 4, max: 300, step: 6, default: VIEWS.chase.height, live: true },
  lookAhead: { kind: "number", label: "Look ahead", help: "The camera looks at a point this far in front of the rat, which leaves room in the picture for where it is going.", min: 0, max: 300, step: 10, default: VIEWS.chase.lookAhead, live: true },
  fov: { kind: "number", label: "Field of view", help: "The vertical field of view in degrees.", min: 30, max: 100, step: 5, default: 55, live: true },
  follow: { kind: "number", label: "Follow speed", help: "How quickly the camera's heading catches up with the rat's; 0 never turns, 20 is rigid.", min: 0, max: 20, step: 1, default: 3, live: true },
  wander: { kind: "toggle", label: "Wander", help: "The rat walks by itself until you steer it.", default: true, live: true },
  seed: seedOption("chase"),
  ...RENDER_OPTIONS,
  e2e: OPTION.e2e,
});
const seed = hashSeed(options.get("seed"));

// The loading screen's rows, in this order.
const app = await boot("chase", {
  blurb: "A camera that follows",
  steps: [STEPS.device, { phase: "terrain", label: "Shaping the terrain" }, STEPS.models, STEPS.shaders, STEPS.pipelines, { phase: "scene", label: "Building the scene" }],
  options,
});
if (app) {
  const { gpu, canvas, info, load, screen } = app;
  // A phone (../shared/scale.ts) gets the phone profile: the renderer's through applyRenderOptions below.
  const phone = phoneProfile(gpu, options);
  const rng = seededRandom(seed);

  // --- ground and scenery: something to move past ---------------------------------------------
  const SIZE = { x: 448, y: 160, z: 448 };
  const terrain = await step(load, "terrain", () => generateTerrain({ width: SIZE.x, depth: SIZE.z, height: SIZE.y, baseY: 12, relief: 5, featureSize: 160, waterLevel: 2, river: { enabled: false, width: 0, depth: 0, banks: 0, meander: 100 } }, seed));
  const hAt = (x: number, z: number) => terrain.heights[Math.max(0, Math.min(SIZE.x - 1, Math.round(x))) + Math.max(0, Math.min(SIZE.z - 1, Math.round(z))) * SIZE.x];
  const palette = new PaletteAllocator(1);
  const { base: groundBase } = palette.allocate(terrain.roles, "terrain");
  const models = load.task("models", 11);
  await nextFrame();
  /** `r`: how close the rat may come (a trunk, or most of a rock). */
  const scenery: { entity: Entity; base: number; x: number; z: number; r: number }[] = [];
  for (let i = 0; i < 10; i++) {
    let entity: Entity;
    if (i < 5) {
      const p = structuredClone(TREES[["oak", "maple", "spruce", "birch", "pine"][i]]);
      p.shape.height = 120;
      entity = generateTree(p, seededRandom(seed + i)).entity;
    } else entity = generateRock(ROCKS[["boulder", "mossy", "sandstone", "outcrop", "limestone"][i - 5]], seededRandom(seed + i)).entity;
    // On a ring round the middle, where the rat starts.
    const a = (i / 10) * Math.PI * 2 + rng(), r = 90 + rng() * 90;
    scenery.push({ entity, base: palette.allocate(entity.model.roles, `scenery${i}`).base, x: SIZE.x / 2 + Math.cos(a) * r, z: SIZE.z / 2 + Math.sin(a) * r, r: i < 5 ? 14 : Math.max(entity.model.size.x, entity.model.size.z) * 0.5 });
    models.tick();
  }
  const rat = generateCreature(RATS.rat, seededRandom(seed + 99)).entity;
  models.tick();
  models.end();

  const renderer = await createRenderer(gpu, { size: SIZE, palette: palette.buildPalette(), materials: palette.buildMaterials() }, { onLoad: trackRenderer(load), deferPipelines: true, background: classicSky });
  renderer.setClipBounds([0, 0, 0], [SIZE.x - 1, SIZE.y - 1, SIZE.z - 1]);
  // A CPU adapter (SwiftShader) starts on the Low preset, and draws small.
  const render = applyRenderOptions(options, renderer, { gpu, phone, moving: true, preset: gpu.software ? "low" : "medium" });
  const scale = gpu.software ? Math.min(gpu.renderScale, 0.3) : gpu.renderScale;
  // The rat is an instance, placed by the first frame: say so, so the right pipelines compile.
  const compiled = prepared(renderer.prepare({ instances: true }));
  await step(load, "scene", () => {
    renderer.edit({ x0: 0, y0: 0, z0: 0, x1: SIZE.x - 1, y1: terrain.maxY(), z1: SIZE.z - 1 }, (cells, ox, oy, oz) => terrain.fillBrick(cells, ox, oy, oz, groundBase));
    for (const s of scenery) blitModelToBricks(renderer, s.entity.model, { x: Math.round(s.x), y: hAt(s.x, s.z) + 1, z: Math.round(s.z) }, s.base);
  });

  // --- the rat: a crowd of one, drawn as an instance --------------------------------------------
  const layer = makeInstanceLayer(renderer, { load });
  const crowd = makeCrowd({ instances: layer, near: 4000, budgetMs: 4 });
  const me: CrowdMember = { id: 1, entity: rat, variant: "rat", anim: makeAnimator(rat, "idle"), base: layer.palettes.of("rat", rat.model.roles), x: SIZE.x / 2, y: 0, z: SIZE.z / 2, yaw: 0.6 };

  // --- input: keys, pad and touch bound to the same actions -----------------------------------
  prepareSurface(canvas, { contextMenu: false });
  const input = createInput(canvas);
  const actions = makeActions(input, {
    steer: axis({ negative: ["key:KeyA", "key:ArrowLeft"], positive: ["key:KeyD", "key:ArrowRight"], analog: ["pad:LeftX", "touch:move.x"] }),
    // Up is negative on a stick, so each half goes to the opposite side.
    go: axis({ negative: ["key:KeyS", "key:ArrowDown", "pad:LeftY+", "touch:move.y+"], positive: ["key:KeyW", "key:ArrowUp", "pad:LeftY-", "touch:move.y-"] }),
    run: button("key:ShiftLeft", "key:ShiftRight", "pad:A", "touch:run"),
  });
  makeTouchControls(input, { joysticks: [{ id: "move", side: "left" }], buttons: [{ id: "run", label: "Run" }] });

  // --- the loop: move the rat, then put the camera behind it -------------------------------------
  let wander = options.get("wander");
  /** The camera's own heading, in degrees: it eases towards the rat's. */
  let camYaw = (me.yaw * 180) / Math.PI;
  let clip = "idle", wanderTurn = 0, wanderTimer = 0;
  const MARGIN = 50;
  /** Whether the rat may stand at (x, z): inside the patch and clear of the scenery. */
  const free = (x: number, z: number) =>
    x > MARGIN && z > MARGIN && x < SIZE.x - MARGIN && z < SIZE.z - MARGIN && scenery.every((s) => Math.hypot(x - s.x, z - s.z) > s.r + 12);
  await compiled;
  runLoop((now, dtRaw) => {
    const dt = Math.min(0.05, dtRaw);
    input.update();
    let [steer, go] = actions.vector("steer", "go");
    const running = actions.down("run");
    if (steer || go) setWander(false);
    else if (wander) {
      // By itself: forwards, changing its mind about the turn now and then, back from the edges.
      if ((wanderTimer -= dt) <= 0) { wanderTurn = (rng() - 0.5) * 1.4; wanderTimer = 1 + rng() * 3; }
      // Something in the way two lengths ahead: turn until there is not.
      steer = free(me.x + Math.sin(me.yaw) * 70, me.z + Math.cos(me.yaw) * 70) ? wanderTurn : 1;
      go = 1;
    }
    // Turning right increases the yaw, as in firstPersonFrame and chaseFrame; the rat turns faster standing than running.
    me.yaw += steer * (go ? 1.6 : 2.4) * dt;
    const speed = go > 0 ? (running ? 110 : 38) * go : go * 18;
    const nx = me.x + Math.sin(me.yaw) * speed * dt, nz = me.z + Math.cos(me.yaw) * speed * dt;
    if (free(nx, nz)) { me.x = nx; me.z = nz; }
    me.y = hAt(me.x, me.z) + 1;
    const next = go > 0 ? (running ? "run" : "walk") : go < 0 ? "walk" : steer > 0.3 ? "turn-right" : steer < -0.3 ? "turn-left" : "idle";
    if (next !== clip) me.anim.play((clip = next), { fade: 0.2 });
    me.anim.update(dt);

    // The camera's heading follows the rat's by the shortest way round.
    const ratYaw = (me.yaw * 180) / Math.PI;
    const behind = ((((ratYaw - camYaw) % 360) + 540) % 360) - 180;
    camYaw += behind * Math.min(1, options.get("follow") * dt);
    const view = chaseFrame([me.x, me.y + 8, me.z], {
      yawDeg: options.get("follow") >= 20 ? ratYaw : camYaw,
      distance: options.get("distance"), height: options.get("height"), lookAhead: options.get("lookAhead"), fovDeg: options.get("fov"),
    });
    crowd.update([me], view.camPos as Vec3);
    gpu.renderScale = render.pace(now, scale);
    resizeToDisplay(gpu);
    renderer.render({ ...view, ...DAYLIGHT });
  }, true);

  // --- HUD -----------------------------------------------------------------------------------
  const viewSel = document.getElementById("view") as HTMLSelectElement | null;
  const wanderBtn = document.getElementById("wander-toggle") as HTMLButtonElement | null;
  function setWander(on: boolean) {
    if (on === wander) return;
    wander = on;
    options.sync("wander", on);
    sync();
  }
  const sync = () => {
    if (viewSel) viewSel.value = options.get("view");
    if (wanderBtn) { wanderBtn.textContent = `Wander: ${wander ? "on" : "off"}`; wanderBtn.setAttribute("aria-pressed", String(wander)); }
    info.textContent = `chaseFrame: ${options.get("distance")} behind, ${options.get("height")} above, looking ${options.get("lookAhead")} ahead, ${options.get("fov")}° · WASD or arrows steer, Shift runs`;
  };
  /** A preset: the three numbers it stands for, in the options too, so the panel and the URL follow. */
  const setView = (v: View) => {
    options.sync("view", v);
    for (const key of ["distance", "height", "lookAhead"] as const) options.sync(key, VIEWS[v][key]);
    sync();
  };
  for (const v of Object.keys(VIEWS) as View[]) viewSel?.append(new Option(v === "eye" ? "View: rat's eye" : `View: ${v}`, v));
  viewSel?.addEventListener("change", () => setView(viewSel.value as View));
  wanderBtn?.addEventListener("click", () => setWander(!wander));
  options.on("view", setView);
  options.on("wander", (on) => { wander = on; sync(); });
  for (const key of ["distance", "height", "lookAhead", "fov", "follow"] as const) options.on(key, sync);
  // A preset named in the URL sets its numbers, unless the URL gives them itself.
  if (options.given("view") && !["distance", "height", "lookAhead"].some((k) => options.given(k as "distance"))) setView(options.get("view"));

  if (options.get("e2e")) Object.assign(window, { chaseStats: () => ({ x: me.x, z: me.z, yaw: me.yaw, camYaw, clip, wander }) });

  sync();
  screen.ready();
  markFrames(load, renderer);
  void reportLoadTimeline(load, { perf: false });
}
