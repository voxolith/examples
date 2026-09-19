// Shared startup: grab the canvas, init WebGPU, and show the engine's
// "unsupported" card instead of a blank page when navigator.gpu is missing.

import { initGpu, showUnsupportedScreen, WebGPUUnsupportedError, type GpuContext } from "@voxolith/renderer";
import "./styles.css";

export interface Booted {
  gpu: GpuContext;
  canvas: HTMLCanvasElement;
  info: HTMLElement;
}

export async function boot(appName: string): Promise<Booted | null> {
  const canvas = document.getElementById("scene") as HTMLCanvasElement | null;
  const info = document.getElementById("info");
  if (!canvas || !info) throw new Error("Missing #scene / #info");
  try {
    const gpu = await initGpu(canvas);
    return { gpu, canvas, info };
  } catch (err) {
    if (err instanceof WebGPUUnsupportedError) {
      showUnsupportedScreen(err.message, { appName, emoji: "🧊" });
      return null;
    }
    throw err;
  }
}

/** requestAnimationFrame loop capped at ~60 Hz; `dt` is seconds. */
export function runLoop(frame: (now: number, dt: number) => void): void {
  let last = performance.now();
  const tick = (now: number) => {
    requestAnimationFrame(tick);
    const ms = now - last;
    if (ms < 1000 / 60 - 1) return;
    last = now;
    frame(now, Math.min(0.05, ms / 1000));
  };
  requestAnimationFrame(tick);
}
