// Terrain worker: samples one band of rows of a terrain's height map (./terrain.ts).
//
// It bundles gen-terrain only. gen-terrain's `terrainHeightsBand` gives exactly the rows
// `generateTerrain` samples, so a few of these workers split the map into bands of rows and the
// page puts the bands together and rebuilds the terrain from them.

import { terrainHeightsBand, type TerrainParams } from "@voxolith/gen-terrain";

/** What the page sends: complete params and the rows `z0..z1 - 1` to sample. */
export interface TerrainRequest {
  params: TerrainParams;
  seed: number;
  z0: number;
  z1: number;
}

/** What the worker answers: the band's heights (`x + (z - z0) * width`), transferred. */
export type TerrainResponse = { ok: true; heights: Int16Array; ms: number } | { ok: false; message: string };

const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<TerrainRequest>) => void) | null;
  postMessage(msg: TerrainResponse, transfer?: Transferable[]): void;
};

scope.onmessage = ({ data }) => {
  try {
    const t0 = performance.now();
    const heights = terrainHeightsBand(data.params, data.seed, data.z0, data.z1);
    scope.postMessage({ ok: true, heights, ms: performance.now() - t0 }, [heights.buffer]);
  } catch (err) {
    scope.postMessage({ ok: false, message: err instanceof Error ? err.message : String(err) });
  }
};
