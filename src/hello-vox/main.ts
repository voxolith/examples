// hello-vox: the smallest useful @voxolith/renderer program.
// Fetch a .vox → dense grid → renderer + occupancy grid → render each frame
// with a slowly rotating orbit camera.

import { createRenderer, OccupancyGrid, makeCamera, parseVox, resizeToDisplay } from "@voxolith/renderer";
import { trackRenderer } from "@voxolith/engine";
import { boot, runLoop } from "../shared/boot";
import { markFrames, prepared, reportLoadTimeline, step } from "../shared/loading";
import { STEPS } from "../shared/loading-screen";
import { STUDIO } from "../shared/env";
import { modelToGrid, frameGrid } from "../shared/voxGrid";

// The loading screen's rows, in this order (phases not listed are not shown, but stay on the
// tracker for window.loadTimeline and ?perf).
const app = await boot("hello-vox", {
  blurb: "A .vox model, rendered",
  steps: [
    STEPS.device,
    { phase: "model", label: "Loading the model" },
    STEPS.shaders,
    STEPS.pipelines,
  ],
});
if (app) {
  // `load` and `screen` are the page's load tracker and loading screen (boot starts both).
  const { gpu, info, load, screen } = app;

  // 1. Load and convert the model.
  const { model, grid } = await step(load, "model", async () => {
    const model = parseVox(await (await fetch(`${import.meta.env.BASE_URL}models/cat-sit.vox`)).arrayBuffer());
    return { model, grid: modelToGrid(model) };
  });

  // 2. Create the renderer for this grid and give it the coarse occupancy
  //    grid so rays skip empty space.
  const renderer = await createRenderer(gpu, grid, { onLoad: trackRenderer(load), deferPipelines: true });
  renderer.updateCoarse(new OccupancyGrid(grid.size, grid.data).data);
  renderer.setFloor({ enabled: true, y: 0, colorA: [0.22, 0.23, 0.27], colorB: [0.17, 0.18, 0.21] });

  // 3. A camera factory: call it with a yaw each frame to get camera vectors.
  const { target, distance } = frameGrid(grid.size);
  const camera = makeCamera({ target, distance, pitchDeg: 28, fovDeg: 32 });

  info.textContent = `${model.size.x}×${model.size.y}×${model.size.z} · ${model.voxels.length.toLocaleString()} voxels`;

  // 4. Compile the pipelines (deferPipelines above: none is made until now), then render.
  await prepared(renderer.prepare());
  runLoop((now) => {
    resizeToDisplay(gpu);
    renderer.render({ ...camera(now / 50), ...STUDIO });
  });
  screen.ready();
  markFrames(load, renderer);
  void reportLoadTimeline(load, { perf: false });
}
