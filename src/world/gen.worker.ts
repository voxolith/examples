// Generator worker for the world page: every entity generator it uses, served by id.

import { registerTreeGenerators } from "@voxolith/gen-tree";
import { registerBushGenerators } from "@voxolith/gen-bush";
import { registerGrassGenerators } from "@voxolith/gen-grass";
import { registerRockGenerators } from "@voxolith/gen-rock";
import { registerBuildingGenerators } from "@voxolith/gen-building";
import { serveGenerators } from "@voxolith/engine/worker";

registerTreeGenerators();
registerBushGenerators();
registerGrassGenerators();
registerRockGenerators();
registerBuildingGenerators();
// Production builds keep generated models in IndexedDB, so a second visit
// loads them instead of generating (a build's worker URL changes with its
// code, so a new build never reads an old model). Off in development.
//
// The cap is ours to size (the engine picks none): enough that a visitor who
// opens every page that uses this worker at every scale evicts nothing, plus a
// margin; least recently used out first. What each page adds (deflated), visited
// in this order on an empty cache (production build, 2026-09-29; default
// ?variants=3; pages share models, so a later page adds only what is new):
//   world      10 vox/m:   0.8 MB
//   valley     20 vox/m:   1.6 MB
//   valley     50 vox/m:   8.7 MB
//   valley    100 vox/m:  26.4 MB
//   nightwood  20 vox/m:   1.2 MB
//   nightwood  50 vox/m:   8.2 MB
//   nightwood 100 vox/m:  27.9 MB
//   bench      20 vox/m:   1.0 MB
//   bench      50 vox/m:   6.8 MB
//   bench     100 vox/m:  23.4 MB
//   total:               106 MB
// 256 MiB (268 MB) leaves room for ?variants= above the default and for
// generators growing. A game sizes its own cap the same way: load each scene
// once and read openModelCacheControls("<name>").usage() from the main thread.
const MAX_BYTES = 256 * 1024 ** 2;
serveGenerators({ cache: import.meta.env.DEV ? undefined : { name: "voxolith-models", maxBytes: MAX_BYTES } });
