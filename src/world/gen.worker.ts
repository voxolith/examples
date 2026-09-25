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
serveGenerators({ cache: import.meta.env.DEV ? undefined : "voxolith-models" });
