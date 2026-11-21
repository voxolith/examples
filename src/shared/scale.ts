// Which device gets which settings: the phone test every page uses (`phoneProfile`), and the
// voxel scale of the pages that have one (valley, nightwood, bench, rigged). ?vpm= itself is a
// declared option of each page (./options.ts), whose default the page picks with its `phone` flag.
// What the phone profile does to the renderer is in ./quality.ts (`PHONE`, `applyRenderOptions`).

import type { GpuContext } from "@voxolith/renderer";
import type { OPTION, PageOptions } from "./options";

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
 * Whether this page load gets the phone profile, from the page's options: a {@link phoneDevice}
 * (or any device with the hidden `?phone`), unless `?full` asks for the desktop settings. Where
 * the device is no phone, `?full` means nothing and leaves the Options panel.
 *
 * Every page calls it once after `boot` and uses the answer twice: for its own content (fewer
 * voxels per metre, a smaller crowd), as the device default of each `options.get`, and for the
 * renderer, by handing it to `applyRenderOptions` (./quality.ts).
 *
 * @example
 * ```ts
 * const phone = phoneProfile(gpu, options);
 * const COUNT = options.get("count", phone ? 120 : 300);
 * const render = applyRenderOptions(options, renderer, { gpu, phone, preset: gpu.software ? "low" : "medium" });
 * ```
 */
export function phoneProfile(gpu: GpuContext, options: PageOptions<any>): boolean {
  const o = options as unknown as PageOptions<Pick<typeof OPTION, "full" | "phone">>;
  const device = (o.given("phone") && o.get("phone") !== "0") || phoneDevice(gpu);
  if (!device) o.hide("full");
  return device && !o.get("full");
}

/**
 * The `?vpm=` option, to spread into a page's declaration (valley and nightwood as it is, with the
 * default they pick per device; bench and rigged with a default and help of their own).
 */
export const vpmOption = {
  kind: "choice", label: "Voxels per metre", help: "The scene's resolution; every model is generated for it. Finer is heavier.",
  values: SCALES, default: 50, snap: true, format: (v: number) => `${v} (${voxelSize(v)} voxels)`,
} as const;

