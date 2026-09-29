// The streamed ground, filled on workers: what valley, nightwood and world share.
//
// A chunk of fine ground at 100 voxels per metre costs 20-40 ms in the terrain's `fillBrick`,
// and 50 ms or so with the brick upload, on the thread that draws. The fill is a pure function of
// the terrain, so it moves: the engine's `makeChunkFillPool` sends the page's ground description
// to a few workers once (./ground.worker.ts rebuilds the terrain from it), `makeChunkedWorld({ fill
// })` hands them each chunk's boxes nearest first, and the main thread only copies the bricks that
// come back in (about 10 ms a chunk at 100 vox/m). `generate` still runs per chunk once its
// bricks are in (the valley counts them there; the world page blits its models there).
//
// The description is taken when the pool is made: level the terrain and settle the surface
// override first. A later height edit needs a new pool.

import type { ChunkedWorld } from "@voxolith/engine";
import { makeChunkFillPool, type ChunkFillPool } from "@voxolith/engine/worker";
import type { FineTerrainInit, TerrainInit } from "@voxolith/gen-terrain";
import { nextFrame } from "./loading";

/**
 * What a ground worker fills from: a fine terrain (gen-terrain's `fineTerrainInit`, its top
 * override included) or a coarse one (`terrainInit`, with the override as `topOverrideData`), and
 * the palette slot of the terrain's first role.
 */
export type GroundInit =
  | { fine: FineTerrainInit; base: number }
  | { terrain: TerrainInit; top?: Uint8Array; base: number };

/**
 * Ground workers for this machine. The generator pool takes up to four cores and the scene worker
 * one, and the main thread needs its own: the ground gets what is left, up to six, and at least
 * one. Measured on valley at 100 vox/m (warm, 24 cores, 2026-09-29): first frame 2.97-3.01 s with
 * 3 workers, 2.77-2.82 s with 4, 2.53-2.55 s with 6 and 2.75-2.79 s with 8, and the fewest long
 * tasks after it with 6.
 */
export function groundWorkers(): number {
  const cores = navigator.hardwareConcurrency || 4;
  return Math.max(1, Math.min(6, cores - 6));
}

/** A chunk-fill pool on ./ground.worker.ts, for `makeChunkedWorld({ fill })`. Destroy it when the ground is done. */
export function groundFill(init: GroundInit, size = groundWorkers()): ChunkFillPool {
  return makeChunkFillPool({
    spawn: () => new Worker(new URL("./ground.worker.ts", import.meta.url), { type: "module" }),
    init,
    size,
  });
}

/**
 * Build the ground within `radius` of (x, z) and resolve: `world.step(budgetMs)` once a frame
 * until it is there. Behind the loading screen the budget can be large; the frame still paints
 * between steps, so the screen moves. Rejects when a chunk in the area fails to fill. The world
 * must have been focused on at least `radius` around the point.
 */
export async function buildAround(world: ChunkedWorld, x: number, z: number, radius: number, budgetMs = 40): Promise<void> {
  let error: { e: unknown } | undefined;
  let done = false;
  world.whenReady(x, z, radius).then(
    () => void (done = true),
    (e) => void (error = { e }),
  );
  while (!done) {
    if (error) throw error.e;
    world.step(budgetMs);
    if (world.readyAround(x, z, radius)) return;
    await nextFrame();
  }
}
