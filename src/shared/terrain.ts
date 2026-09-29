// A terrain generated off the main thread (valley, world).
//
// Sampling a terrain's height map is pure CPU and takes a second and a half in the browser for
// the valley's 1280 x 1280 columns. gen-terrain's `terrainHeightsBand` samples any band of rows,
// so a few workers (./terrain.worker.ts) each sample one while the page does something else
// (asks for its models, creates its renderer), and the page rebuilds the same `Terrain` from the
// bands with `generateTerrain(params, seed, { heights })`, a few ms: byte for byte what
// `generateTerrain(params, seed)` gives here.

import { completeTerrainParams, generateTerrain, terrainSize, type Terrain, type TerrainParams } from "@voxolith/gen-terrain";
import type { TerrainRequest, TerrainResponse } from "./terrain.worker";

/**
 * Workers to sample with: the terrain is the first thing a page waits for, and only the generator
 * pool (up to four) runs beside it, so up to six, leaving the main thread and those a core each.
 */
const bandCount = () => Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 6));

/**
 * `generateTerrain(params, seed)` with its height map sampled on workers, in bands of rows. Falls
 * back to generating on this thread if a worker cannot start or fails (logged), so the page still
 * loads.
 *
 * @param bands - How many workers (default: the cores to spare, up to six).
 */
export async function terrainOffThread(params: Partial<TerrainParams>, seed: number, bands = bandCount()): Promise<Terrain> {
  const here = () => generateTerrain(params, seed);
  if (typeof Worker === "undefined") return here();
  const p = completeTerrainParams(params);
  const { width: W, depth: D } = terrainSize(p);
  const n = Math.max(1, Math.min(bands, D));
  const workers: Worker[] = [];
  try {
    const heights = new Int16Array(W * D);
    await Promise.all(Array.from({ length: n }, (_, i) => {
      const z0 = Math.floor((i * D) / n), z1 = Math.floor(((i + 1) * D) / n);
      return new Promise<void>((resolve, reject) => {
        const worker = new Worker(new URL("./terrain.worker.ts", import.meta.url), { type: "module" });
        workers.push(worker);
        worker.onmessage = ({ data }: MessageEvent<TerrainResponse>) => {
          if (!data.ok) return reject(new Error(data.message));
          heights.set(data.heights, z0 * W);
          resolve();
        };
        worker.onerror = (ev) => {
          ev.preventDefault();
          reject(new Error(ev.message || "worker error"));
        };
        worker.postMessage({ params: p, seed, z0, z1 } satisfies TerrainRequest);
      });
    }));
    return generateTerrain(params, seed, { heights });
  } catch (err) {
    console.warn("[terrain] a terrain worker failed; generating on the main thread:", err);
    return here();
  } finally {
    for (const w of workers) w.terminate();
  }
}
