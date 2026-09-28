// The placement worker shared by the pages with static instance scenery: bakes an instance
// layer's static set (the renderer's per-cell lists and sub-cell tables) off the main thread, so
// the loading screen keeps animating while a scene of thousands of instances is placed. See
// ./placement.ts for the main-thread side.

import { servePlacement } from "@voxolith/engine/worker";

servePlacement();
