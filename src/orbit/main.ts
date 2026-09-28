// orbit: a procedural terrain grid written directly into the voxel array, and
// the engine's orbit controller: drag to turn, wheel or pinch to zoom,
// right-drag or two fingers to pan.

import { createRenderer, OccupancyGrid, makeCamera, observeResize, resizeToDisplay } from "@voxolith/renderer";
import { createInput, makeOrbitController, prepareSurface } from "@voxolith/engine/input";
import { trackRenderer } from "@voxolith/engine";
import { boot, runLoop } from "../shared/boot";
import { prepared, reportLoadTimeline } from "../shared/loading";
import { STEPS } from "../shared/loading-screen";
import { DAYLIGHT } from "../shared/env";

// The loading screen's rows, in this order (phases not listed are not shown, but stay on the
// tracker for window.loadTimeline and ?perf).
const app = await boot("orbit", {
  blurb: "Procedural hills to orbit",
  steps: [
    STEPS.device,
    STEPS.shaders,
    STEPS.pipelines,
  ],
});
if (app) {
  const { gpu, canvas, load, screen } = app;

  // A 96×32×96 grid: layered sine hills with three palette slots (grass,
  // dirt, water). Slot 0 is always empty.
  const size = { x: 96, y: 32, z: 96 };
  const data = new Uint8Array(size.x * size.y * size.z);
  const GRASS = 1, DIRT = 2, WATER = 3;
  const idx = (x: number, y: number, z: number) => x + y * size.x + z * size.x * size.y;
  for (let z = 0; z < size.z; z++) {
    for (let x = 0; x < size.x; x++) {
      const h = Math.round(8 + 5 * Math.sin(x / 9) * Math.cos(z / 11) + 3 * Math.sin((x + z) / 7));
      for (let y = 0; y <= Math.max(h, 6); y++) {
        data[idx(x, y, z)] = y > h ? WATER : y === h ? GRASS : DIRT;
      }
    }
  }
  const palette = new Float32Array(256 * 4);
  palette.set([0.36, 0.62, 0.28, 1], GRASS * 4);
  palette.set([0.45, 0.33, 0.22, 1], DIRT * 4);
  palette.set([0.25, 0.5, 0.85, 1], WATER * 4);

  const renderer = await createRenderer(gpu, { size, data, palette }, { onLoad: trackRenderer(load), deferPipelines: true });
  // ?selftest: bands showing which stage of the voxel lookup works on this GPU.
  { const st = new URLSearchParams(location.search).get("selftest"); if (st !== null) renderer.setDebug(st === "3" ? 9 : st === "2" ? 8 : 7); }
  renderer.updateCoarse(new OccupancyGrid(size, data).data);
  renderer.setFloor({ enabled: true, y: 0, colorA: [0.3, 0.32, 0.36], colorB: [0.24, 0.26, 0.3] });

  // Nothing animates here, so render on demand: the loop only draws when
  // input or a resize invalidates it.
  const camera = makeCamera({ target: [size.x / 2, 8, size.z / 2], distance: 200, pitchDeg: 32, fovDeg: 35 });
  // deferPipelines above: compile the pipelines before the first frame.
  await prepared(renderer.prepare());
  const loop = runLoop(() => {
    resizeToDisplay(gpu);
    renderer.render({ ...camera(orbit.yaw(), orbit.distance(), orbit.target(), orbit.pitch()), ...DAYLIGHT });
  }, false);
  observeResize(canvas, loop);

  // One input per surface; the controller reads it. Passing the loop makes
  // every input event request a frame.
  prepareSurface(canvas, { contextMenu: false });
  const input = createInput(canvas, { loop });
  const orbit = makeOrbitController(input, {
    yaw: 35, pitch: 32, distance: 200, distanceLimits: [40, 600], pitchLimits: [8, 85],
    target: [size.x / 2, 8, size.z / 2], pan: "secondary", fovDeg: 35,
  });
  loop.invalidate();
  screen.ready();
  void reportLoadTimeline(load, { perf: false });
}
