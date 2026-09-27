// What the loading screen calls things: one map of phase names to the words shown for them, and
// one of page names to the line under each page's title. The engine only reports phase names
// (`LOAD_PHASES` plus whatever a page adds); the words are the examples' own.

/**
 * Phase names to what the loading screen shows for them. The engine's own phases (`shaders`,
 * `pipelines`, `models`, `upload`, `placement`, `ground`) and every app phase the example pages
 * open; a phase missing here is shown by its name.
 */
export const PHASE_LABELS: Readonly<Record<string, string>> = {
  // boot(): the adapter and device.
  device: "Starting WebGPU",
  // The renderer, through trackRenderer.
  shaders: "Linking shaders",
  pipelines: "Compiling pipelines",
  // The generator pool, the instance layer and the chunked world.
  models: "Generating models",
  upload: "Uploading models",
  placement: "Placing instances",
  ground: "Building the ground",
  // The pages' own phases.
  model: "Loading the model",
  region: "Reading the region file",
  terrain: "Shaping the terrain",
  houses: "Measuring the houses",
  layout: "Laying out the valley",
  creatures: "Generating rats",
  trees: "Growing trees",
  scene: "Building the scene",
  scenery: "Placing the scenery",
  wood: "Planting the wood",
};

/** Page names (as passed to `boot`) to the line under the title on their loading screen. */
export const PAGE_BLURBS: Readonly<Record<string, string>> = {
  "hello-vox": "A .vox model, rendered",
  orbit: "Procedural hills to orbit",
  "minecraft-region": "A Minecraft region, first person",
  world: "A generated valley at 10 voxels per metre",
  valley: "The valley, refined and streamed",
  nightwood: "A forest clearing at night",
  creature: "Rigged, animated rats",
  rigged: "Baked and GPU-posed rats, side by side",
  swarm: "A crowd of animated rats",
  instances: "Scenery and a crowd drawn by reference",
  temporal: "Shadows and AO accumulated over frames",
  bench: "The renderer benchmark scene",
};

/** What the loading screen shows for `phase`. */
export const phaseLabel = (phase: string): string => PHASE_LABELS[phase] ?? phase;
