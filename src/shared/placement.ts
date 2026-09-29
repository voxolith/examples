// The main-thread side of ./placement.worker.ts: one scene worker for the page.
//
// Give it to `makeInstanceLayer(renderer, { load, worker })`, set the static set and
// `await layer.commitAsync()`: `setStatic` only sends the models to be encoded, and the commit
// waits for the encodes, reserves the brick pools once for the batch, adds the models a few per
// frame and bakes the set, all while the page keeps painting. The engine's `upload` phase spans
// the encodes and adds (counted in bricks), `placement` the bake.

import type { InstanceLayer } from "@voxolith/engine";
import { makeSceneWorker, type SceneWorker } from "@voxolith/engine/worker";

/** Start the page's scene worker. One per page: it can serve several layers. */
export function sceneWorker(): SceneWorker {
  return makeSceneWorker({ spawn: () => new Worker(new URL("./placement.worker.ts", import.meta.url), { type: "module" }) });
}

/**
 * `layer.commitAsync()`, falling back to a synchronous `layer.commit()` if an encode or the bake
 * fails on the worker (the layer then counts the static set as unsent, so the commit uploads what
 * is missing and places it here).
 */
export async function commitStatic(layer: InstanceLayer): Promise<void> {
  try {
    await layer.commitAsync();
  } catch (err) {
    console.warn("[placement] the scene worker failed; uploading and placing on the main thread:", err);
    layer.commit();
  }
}
