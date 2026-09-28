// The main-thread side of ./placement.worker.ts: one placement worker for the page.
//
// Give it to `makeInstanceLayer(renderer, { load, placement })`, set the static set and
// `await layer.commitAsync()`: the bake runs on the worker (the engine's `placement` phase spans
// it, request to apply) while the page keeps painting. Uploads (`setStatic`) still run on the
// main thread.

import type { InstanceLayer } from "@voxolith/engine";
import { makePlacementWorker, type PlacementWorker } from "@voxolith/engine/worker";

/** Start the page's placement worker. One per page: it can serve several layers. */
export function placementWorker(): PlacementWorker {
  return makePlacementWorker({ spawn: () => new Worker(new URL("./placement.worker.ts", import.meta.url), { type: "module" }) });
}

/**
 * `layer.commitAsync()`, falling back to a synchronous `layer.commit()` if the worker's bake
 * fails (the layer then counts the static set as unsent, so the commit places it here).
 */
export async function commitStatic(layer: InstanceLayer): Promise<void> {
  try {
    await layer.commitAsync();
  } catch (err) {
    console.warn("[placement] the worker's bake failed; placing on the main thread:", err);
    layer.commit();
  }
}
