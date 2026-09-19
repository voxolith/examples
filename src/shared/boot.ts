// Shared startup: grab the canvas, init WebGPU, and show the engine's
// "unsupported" card instead of a blank page when navigator.gpu is missing.

import {
  initGpu,
  makeFrameLoop,
  showUnsupportedScreen,
  WebGPUUnsupportedError,
  type FrameLoop,
  type GpuContext,
} from "@voxolith/renderer";
import "./styles.css";
import { initTheme } from "../brand/theme";

const MARK = `<img src="${import.meta.env.BASE_URL}brand/logo-mark.svg" alt="" width="72" height="72">`;

export interface Booted {
  gpu: GpuContext;
  canvas: HTMLCanvasElement;
  info: HTMLElement;
}

export async function boot(appName: string): Promise<Booted | null> {
  const canvas = document.getElementById("scene") as HTMLCanvasElement | null;
  const info = document.getElementById("info");
  if (!canvas || !info) throw new Error("Missing #scene / #info");
  initTheme(document.getElementById("theme-toggle"));
  try {
    const gpu = await initGpu(canvas);
    return { gpu, canvas, info };
  } catch (err) {
    if (err instanceof WebGPUUnsupportedError) {
      showUnsupportedScreen(err.message, { appName, iconHtml: MARK });
      return null;
    }
    throw err;
  }
}

/**
 * Frame loop built on the engine's render-on-demand loop. `continuous: true`
 * (the default here) renders every frame, for examples that animate; pass
 * `false` and call `loop.invalidate()` when something changes instead.
 */
export function runLoop(frame: (now: number, dt: number) => void, continuous = true): FrameLoop {
  return makeFrameLoop({ render: frame, continuous });
}
