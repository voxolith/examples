// The voxel scale of the fine-scale pages (valley, nightwood, bench): which device
// gets which voxels per metre, ?vpm=, and the HUD's scale button.

import type { GpuContext } from "@voxolith/renderer";

/** The scales these pages offer, in voxels per metre: 5, 2 and 1 cm voxels. */
export const SCALES = [20, 50, 100] as const;
/** One of {@link SCALES}. */
export type Scale = (typeof SCALES)[number];

/**
 * Whether to give this device the phone profile: a touch-only pointer, or the
 * small storage bindings mobile GPUs offer. `?full` asks for the desktop
 * settings anyway.
 */
export function isPhone(gpu: GpuContext, params: URLSearchParams): boolean {
  if (params.has("full")) return false;
  const touchOnly = matchMedia("(pointer: coarse)").matches && !matchMedia("(pointer: fine)").matches;
  return touchOnly || gpu.limits.maxStorageBufferBindingSize < 512 * 1048576;
}

/** The size of a voxel at `vpm`, for labels ("5 cm", "2 cm", "1 cm"). */
export const voxelSize = (vpm: number) => `${100 / vpm} cm`;

/**
 * The page's voxels per metre: `?vpm=` snapped to the nearest of
 * {@link SCALES}, or the device's default (20 on a phone, 50 elsewhere; `fallback` overrides
 * it for a page with a fixed default).
 * Wires the HUD's `#scale-toggle` button, which steps between the default and
 * one scale finer (a phone 20 and 50, a desktop 50 and 100) and, from any
 * other scale, back to the default. It reloads with every other URL option
 * kept, since every model is generated for its scale.
 */
export function pickScale(params: URLSearchParams, phone: boolean, fallback: Scale = phone ? 20 : 50): Scale {
  const asked = params.has("vpm") ? Number(params.get("vpm")) : NaN;
  const vpm = Number.isFinite(asked)
    ? SCALES.reduce((best, s) => (Math.abs(s - asked) < Math.abs(best - asked) ? s : best))
    : fallback;
  const finer = SCALES[SCALES.indexOf(fallback) + 1];
  const target = vpm === fallback ? finer : fallback;
  const button = document.getElementById("scale-toggle") as HTMLButtonElement | null;
  if (button) {
    button.textContent = `Switch to ${voxelSize(target)}`;
    button.title = `Switch to ${target} voxels per metre (reloads the scene)`;
    button.onclick = () => {
      const next = new URLSearchParams(location.search);
      next.set("vpm", String(target));
      location.search = next.toString();
    };
  }
  return vpm;
}
