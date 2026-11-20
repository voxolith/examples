// The voxel scale of the pages that have one (valley, nightwood, bench, rigged): which device
// gets which voxels per metre. ?vpm= itself is a declared option of each page
// (./options.ts), whose default the page picks with `isPhone`.

import type { GpuContext } from "@voxolith/renderer";

/**
 * The scales every page with a `?vpm=` offers, in voxels per metre: 10 (the generators' native
 * scale, 10 cm voxels), 20, 30, 40 and 50 (2 cm). Anything else snaps to the nearest, so an old
 * `?vpm=100` link opens at 50.
 */
export const SCALES = [10, 20, 30, 40, 50] as const;
/** One of {@link SCALES}. */
export type Scale = (typeof SCALES)[number];

/** The size of a voxel at `vpm`, for labels ("10 cm", "3.3 cm", "2 cm"). */
export const voxelSize = (vpm: number) => `${+(100 / vpm).toFixed(1)} cm`;

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

/**
 * The `?vpm=` option, to spread into a page's declaration (valley and nightwood as it is, with the
 * default they pick per device; bench and rigged with a default and help of their own).
 */
export const vpmOption = {
  kind: "choice", label: "Voxels per metre", help: "The scene's resolution; every model is generated for it. Finer is heavier.",
  values: SCALES, default: 50, snap: true, format: (v: number) => `${v} (${voxelSize(v)} voxels)`,
} as const;

