// Convert a parsed MagicaVoxel model into the dense grid the renderer wants.
// MagicaVoxel is Z-up; the engine is Y-up, so (x, y, z) becomes (x, z, y).
// The model is cropped to its occupied box so it frames nicely.

import type { VoxModel } from "@voxolith/renderer";

export interface Grid {
  size: { x: number; y: number; z: number };
  data: Uint8Array;
  /** 256 × RGBA floats in 0..1, indexed by palette slot. */
  palette: Float32Array;
}

export function modelToGrid(m: VoxModel): Grid {
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (const v of m.voxels) {
    min = [Math.min(min[0], v.x), Math.min(min[1], v.y), Math.min(min[2], v.z)];
    max = [Math.max(max[0], v.x), Math.max(max[1], v.y), Math.max(max[2], v.z)];
  }
  if (!isFinite(min[0])) min = max = [0, 0, 0];

  const size = { x: max[0] - min[0] + 1, y: max[2] - min[2] + 1, z: max[1] - min[1] + 1 };
  const data = new Uint8Array(size.x * size.y * size.z);
  for (const v of m.voxels) {
    const x = v.x - min[0], y = v.z - min[2], z = v.y - min[1];
    data[x + y * size.x + z * size.x * size.y] = v.c;
  }

  const palette = new Float32Array(256 * 4);
  for (let i = 1; i < 256; i++) {
    if (m.palette[i * 4 + 3] === 0) continue;
    palette[i * 4] = m.palette[i * 4] / 255;
    palette[i * 4 + 1] = m.palette[i * 4 + 1] / 255;
    palette[i * 4 + 2] = m.palette[i * 4 + 2] / 255;
    palette[i * 4 + 3] = 1;
  }
  return { size, data, palette };
}

/** Look-at target (grid centre) and a distance that frames the whole grid. */
export function frameGrid(size: { x: number; y: number; z: number }) {
  const max = Math.max(size.x, size.y, size.z);
  return { target: [size.x / 2, size.y / 2, size.z / 2] as [number, number, number], distance: max * 2.2 + 16 };
}
