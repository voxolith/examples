// The voxel scale of the fine-scale pages (valley, nightwood): which device
// gets which voxels per metre. ?vpm= itself is a declared option of each page
// (./options.ts), whose default the page picks with `isPhone`.

import type { GpuContext } from "@voxolith/renderer";

/** The scales these pages offer, in voxels per metre: 5, 2 and 1 cm voxels. */
export const SCALES = [20, 50, 100] as const;
/** One of {@link SCALES}. */
export type Scale = (typeof SCALES)[number];

/** The size of a voxel at `vpm`, for labels ("5 cm", "2 cm", "1 cm"). */
export const voxelSize = (vpm: number) => `${100 / vpm} cm`;

/**
 * Whether this is a device the pages give a phone profile: a touch-only
 * pointer, or the small storage bindings mobile GPUs offer.
 */
export function phoneDevice(gpu: GpuContext): boolean {
  const touchOnly = matchMedia("(pointer: coarse)").matches && !matchMedia("(pointer: fine)").matches;
  return touchOnly || gpu.limits.maxStorageBufferBindingSize < 512 * 1048576;
}

/**
 * Whether to give this device the phone profile: a {@link phoneDevice},
 * unless `full` (the page's `?full` option) asks for the desktop settings
 * anyway.
 */
export function isPhone(gpu: GpuContext, full: boolean): boolean {
  return !full && phoneDevice(gpu);
}

/** The `?vpm=` option of valley and nightwood, to spread into their declarations. */
export const vpmOption = {
  kind: "choice", label: "Voxels per metre", help: "The scene's resolution; every model is generated for it. Finer is heavier.",
  values: SCALES, default: 50, snap: true, format: (v: number) => `${v} (${voxelSize(v)} voxels)`,
} as const;

