// hello-vox: the smallest useful @voxolith/renderer program.
// Fetch a .vox → dense grid → renderer → render each frame
// with a slowly rotating orbit camera.
//
// The page has no options of its own, only the ones every page shares (the HUD's Options panel):
// the renderer's ?quality=, ?temporal=1, ?upscale=, ?reflections=0, ?renderScale=, ?debug=, and
// ?perf. A phone gets the phone profile (../shared/quality.ts): fewer rays traced, resolved to
// the output over frames; ?full gives it the desktop settings.

import { createRenderer, makeCamera, parseVox, resizeToDisplay } from "@voxolith/renderer";
import { trackRenderer } from "@voxolith/engine";
import { boot, runLoop } from "../shared/boot";
import { markFrames, prepared, reportLoadTimeline, step } from "../shared/loading";
import { STEPS } from "../shared/loading-screen";
import { classicSky } from "@voxolith/engine/atmosphere";
import { STUDIO } from "../shared/env";
import { modelToGrid, frameGrid } from "../shared/voxGrid";
import { defineOptions, RENDER_OPTIONS } from "../shared/options";
import { applyRenderOptions } from "../shared/quality";
import { phoneProfile } from "../shared/scale";

const options = defineOptions({ ...RENDER_OPTIONS });

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
  options,
});
if (app) {
  // `load` and `screen` are the page's load tracker and loading screen (boot starts both).
  const { gpu, info, load, screen } = app;

  // 1. Load and convert the model.
  const { model, grid } = await step(load, "model", async () => {
    const model = parseVox(await (await fetch(`${import.meta.env.BASE_URL}models/cat-sit.vox`)).arrayBuffer());
    return { model, grid: modelToGrid(model) };
  });

  // 2. Create the renderer for this grid: it keeps the voxels as sparse bricks,
  //    so rays skip empty space on their own. A CPU adapter (SwiftShader) starts on the Low preset: no shadows or ambient occlusion.
  const renderer = await createRenderer(gpu, grid, { onLoad: trackRenderer(load), deferPipelines: true, background: classicSky });
  //    The quality comes from the page's options; a phone gets the lighter phone profile.
  const render = applyRenderOptions(options, renderer, { gpu, phone: phoneProfile(gpu, options), preset: gpu.software ? "low" : "high" });
  const scale = gpu.renderScale;
  renderer.setFloor({ enabled: true, y: 0, colorA: [0.22, 0.23, 0.27], colorB: [0.17, 0.18, 0.21] });

  // 3. A camera factory: call it with a yaw each frame to get camera vectors.
  const { target, distance } = frameGrid(grid.size);
  const camera = makeCamera({ target, distance, pitchDeg: 28, fovDeg: 32 });

  info.textContent = `${model.size.x}×${model.size.y}×${model.size.z} · ${model.voxels.length.toLocaleString()} voxels`;

  // 4. Compile the pipelines (deferPipelines above: none is made until now), then render.
  await prepared(renderer.prepare());
  runLoop((now) => {
    gpu.renderScale = render.pace(now, scale);
    resizeToDisplay(gpu);
    renderer.render({ ...camera(now / 50), ...STUDIO });
  });
  screen.ready();
  markFrames(load, renderer);
  void reportLoadTimeline(load, { perf: false });
}
