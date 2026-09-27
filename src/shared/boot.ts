// Shared startup: grab the canvas, init WebGPU, and show the engine's
// "unsupported" card instead of a blank page when navigator.gpu is missing.
// It also starts the page's load tracker and loading screen, so every page
// shows its load the same way: the page reports into `load` and calls
// `screen.ready()` once it has drawn.

import {
  initGpu,
  makeFrameLoop,
  showUnsupportedScreen,
  WebGPUUnsupportedError,
  type FrameLoop,
  type GpuContext,
} from "@voxolith/renderer";
import { makeLoadTracker, type LoadTracker } from "@voxolith/engine";
import "./styles.css";
import { NO_SCREEN, showLoadingScreen, type LoadingScreen } from "./loading-screen";
import { initTheme } from "../brand/theme";

const MARK = `<img src="${import.meta.env.BASE_URL}brand/logo-mark.svg" alt="" width="72" height="72">`;

export interface Booted {
  gpu: GpuContext;
  canvas: HTMLCanvasElement;
  info: HTMLElement;
  /** The page's load tracker: pass it to the renderer (`trackRenderer`) and the loaders. */
  load: LoadTracker;
  /** The loading screen reading `load`: call `ready()` once the page has drawn. */
  screen: LoadingScreen;
}

/** Options for {@link boot}. */
export interface BootOptions {
  /**
   * Show the loading screen from the start (default true). A page that waits for the user first
   * (minecraft-region) passes false and opens a screen of its own when its load starts.
   */
  loading?: boolean;
}

export async function boot(appName: string, opts: BootOptions = {}): Promise<Booted | null> {
  const canvas = document.getElementById("scene") as HTMLCanvasElement | null;
  const info = document.getElementById("info");
  if (!canvas || !info) throw new Error("Missing #scene / #info");
  initTheme(document.getElementById("theme-toggle"));
  // On a phone the info is one line; a tap shows the rest.
  info.addEventListener("click", () => info.classList.toggle("open"));
  const load = makeLoadTracker();
  const screen = opts.loading === false ? NO_SCREEN : showLoadingScreen(load, { title: appName });
  const device = load.task("device");
  try {
    const gpu = await initGpu(canvas);
    reportGpuErrors(gpu);
    return { gpu, canvas, info, load, screen };
  } catch (err) {
    if (err instanceof WebGPUUnsupportedError) {
      screen.dispose();
      showUnsupportedScreen(err.message, { appName, iconHtml: MARK });
      return null;
    }
    screen.fail(err);
    throw err;
  } finally {
    device.end();
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

/**
 * Show GPU validation and out-of-memory errors, and a lost device, in the
 * page: on a phone there is no console to find them in, and a page that
 * draws nothing says nothing about why.
 */
function reportGpuErrors(gpu: GpuContext): void {
  let box: HTMLElement | null = null;
  let first = "";
  let count = 0;
  const show = (msg: string) => {
    console.error("[gpu]", msg);
    if (!box) {
      box = document.createElement("div");
      box.className = "gpu-error";
      (document.getElementById("hud") ?? document.body).append(box);
    }
    // The first error is the one that explains the rest.
    if (!count) first = msg;
    count++;
    box.textContent = `GPU: ${first}${count > 1 ? `\n(+${count - 1} more)` : ""}`;
  };
  gpu.device.addEventListener("uncapturederror", (e) => show((e as GPUUncapturedErrorEvent).error.message));
  gpu.device.lost.then((info) => {
    if (info.reason !== "destroyed") show(`device lost: ${info.message || info.reason}`);
  });
  if (new URLSearchParams(location.search).has("diag")) {
    const a = gpu.adapterInfo, l = gpu.limits;
    show(`diag · ${[a.vendor, a.architecture, a.description].filter(Boolean).join(" ")} · 3D ${l.maxTextureDimension3D} · binding ${(l.maxStorageBufferBindingSize / 1048576).toFixed(0)} MiB · storage/stage ${gpu.device.limits.maxStorageBuffersPerShaderStage}`);
  }
}
