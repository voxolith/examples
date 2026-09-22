// Generator worker for the village: every generator the scene uses, served by id.

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
serveGenerators();
