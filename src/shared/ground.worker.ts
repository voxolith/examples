// Ground-fill worker: fills the streamed ground's bricks off the main thread (./ground.ts).
//
// The engine's `serveChunks` gets the page's ground description once, and this file turns it
// into a fill: a fine terrain rebuilt from gen-terrain's `fineTerrainInit` data (valley,
// nightwood), or the coarse terrain from its `terrainInit` plus the settlement's surface as data
// (world). Either writes exactly the bricks the main thread would.

import { serveChunks } from "@voxolith/engine/worker";
import { fineTerrainFrom, generateTerrain } from "@voxolith/gen-terrain";
import type { GroundInit } from "./ground";

serveChunks({
  make(data) {
    const init = data as GroundInit;
    if ("fine" in init) {
      const fine = fineTerrainFrom(init.fine);
      return (cells, ox, oy, oz) => fine.fillBrick(cells, ox, oy, oz, init.base);
    }
    const t = init.terrain;
    const terrain = generateTerrain(t.params, t.seed, { heights: t.heights });
    const top = init.top;
    return (cells, ox, oy, oz) => terrain.fillBrick(cells, ox, oy, oz, init.base, top);
  },
});
