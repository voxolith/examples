// Generator worker for the forest.
//
// Importing a generator package registers it; serveGenerators() then answers
// requests from the pool by id. Generators are pure and take all randomness
// from an injected rng, so nothing else is needed to make them worker-safe.

import { registerTreeGenerators } from "@voxolith/gen-tree";
import { registerBushGenerators } from "@voxolith/gen-bush";
import { registerGrassGenerators } from "@voxolith/gen-grass";
import { serveGenerators } from "@voxolith/engine/worker";

registerTreeGenerators();
registerBushGenerators();
registerGrassGenerators();
serveGenerators();
