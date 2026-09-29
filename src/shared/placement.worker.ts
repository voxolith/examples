// The scene worker shared by the pages with static instance scenery: encodes the static set's
// models for the GPU and bakes the set (the renderer's per-cell lists and sub-cell tables) off the
// main thread, so the loading screen keeps animating while a scene of thousands of instances is
// uploaded and placed. See ./placement.ts for the main-thread side.
//
// In production builds it keeps what it computes in IndexedDB (`voxolith-scene`): encodings under
// the model keys the pages pass (`makeInstanceLayer(renderer, { worker, modelKey })`), bakes under
// a digest of the static set, all salted with this worker's hashed URL, so a warm visit reads them
// instead of recomputing. Off in development: there the URL does not change with the code, so
// stale entries would be served (as for the generator worker's model cache).

import { serveScene } from "@voxolith/engine/worker";

// The cap is ours to size (the engine picks none): enough that a visitor who opens every page at
// every scale evicts nothing, plus a margin; least recently used out first when it is exceeded.
// What each page adds, visited in this order on an empty cache (production build, desktop Chrome,
// 2026-09-29; default ?variants=3). valley and nightwood at 50 and 100 keep two stages
// (../shared/detail.ts): the 10 vox/m models' encodings are small, but their bake is about as big
// as the fine one, since the tables are laid out in world cells, not model voxels.
//   valley     20 vox/m:   17 MB
//   valley     50 vox/m:  177 MB
//   valley    100 vox/m:  824 MB
//   nightwood  20 vox/m:   13 MB
//   nightwood  50 vox/m:  129 MB
//   nightwood 100 vox/m:  655 MB
//   instances:              1 MB
//   total:              1816 MB (the phone profile, 20 vox/m with one variant, adds its own
//                                smaller bakes on the models above)
// bench bakes on the main thread and stores nothing here. 2.5 GiB (2684 MB) leaves about 45% for
// ?variants= above the default and for generators growing. A game sizes its own cap the same way:
// load each scene once and read openSceneCacheControls("<name>").usage() from the main thread.
const MAX_BYTES = 2.5 * 1024 ** 3;

serveScene({ cache: import.meta.env.DEV ? undefined : { name: "voxolith-scene", maxBytes: MAX_BYTES } });
