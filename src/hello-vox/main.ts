// hello-vox: the smallest useful @voxolith/renderer program.
// Fetch a .vox → dense grid → renderer + occupancy grid → render each frame
// with a slowly rotating orbit camera.

import { createRenderer, OccupancyGrid, makeCamera, parseVox, resizeToDisplay } from "@voxolith/renderer";
import { boot, runLoop } from "../shared/boot";
import { STUDIO } from "../shared/env";
import { modelToGrid, frameGrid } from "../shared/voxGrid";

const app = await boot("hello-vox");
if (app) {
  const { gpu, info } = app;

  // 1. Load and convert the model.
  const model = parseVox(await (await fetch(`${import.meta.env.BASE_URL}models/cat-sit.vox`)).arrayBuffer());
  const grid = modelToGrid(model);

  // 2. Create the renderer for this grid and give it the coarse occupancy
  //    grid so rays skip empty space.
  const renderer = await createRenderer(gpu, grid);
  renderer.updateCoarse(new OccupancyGrid(grid.size, grid.data).data);
  renderer.setFloor({ enabled: true, y: 0, colorA: [0.22, 0.23, 0.27], colorB: [0.17, 0.18, 0.21] });

  // 3. A camera factory: call it with a yaw each frame to get camera vectors.
  const { target, distance } = frameGrid(grid.size);
  const camera = makeCamera({ target, distance, pitchDeg: 28, fovDeg: 32 });

  info.textContent = `${model.size.x}×${model.size.y}×${model.size.z} · ${model.voxels.length.toLocaleString()} voxels`;

  // 4. Render.
  runLoop((now) => {
    resizeToDisplay(gpu);
    renderer.render({ ...camera(now / 50), ...STUDIO });
  });
}
