// Load plumbing shared by the pages: waiting a frame, running a blocking step as an app phase, and
// publishing the load timeline.
//
// The engine reports what is loading (`makeLoadTracker`, with the renderer, the generator pool,
// the chunked world and the instance layer reporting into one tracker) and draws nothing;
// ./loading-screen.ts draws it. Events arrive synchronously, so a phase that blocks the main
// thread (an upload, the static placement) only reaches the screen after it has finished. A page
// that wants its row up before such a step opens an app phase of its own, waits a frame
// (`nextFrame`, or `step` for both), then runs the step.

import type { Perf } from "@voxolith/renderer";
import { formatTimeline, type LoadTracker, type TimelineEntry } from "@voxolith/engine";

declare global {
  interface Window {
    /** The page's load timeline (the engine's `LoadTracker.timeline`), for the bench. Set once the page has loaded. */
    loadTimeline?: () => TimelineEntry[];
  }
}

/**
 * Resolves once the next frame has been painted, so text written before it is on screen. A
 * promise resolved from the animation-frame callback itself would not do: the code awaiting it
 * runs as a microtask straight after the callback, before the paint, so a blocking step there
 * still hides the text. A task queued from the callback runs after the paint.
 */
export const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

/**
 * Run `fn` as the app phase `phase` of `load`: open the phase, wait a frame so the loading
 * screen shows its row, run `fn` (blocking or not), and close the phase, also when `fn` throws.
 */
export async function step<T>(load: LoadTracker, phase: string, fn: () => T | Promise<T>): Promise<T> {
  const task = load.task(phase);
  try {
    await nextFrame();
    return await fn();
  } finally {
    task.end();
  }
}

/** Options for {@link reportLoadTimeline}. */
export interface ReportOptions {
  /** Log the timeline to the console (the page's `?perf`). */
  perf: boolean;
  /** The perf overlay, to show the load time in its label under `perf`. */
  overlay?: Perf;
  /** The overlay's label to keep in front of the load time. */
  label?: string;
}

/**
 * Call once the page has kicked off its whole load. Waits until the tracker is idle and one
 * frame has been drawn (the first frame compiles pipelines lazily, which reopens `pipelines`),
 * then sets `window.loadTimeline` and, under `perf`, logs `formatTimeline` to the console and
 * puts the load time in the perf overlay's label. Resolves with the timeline.
 */
export async function reportLoadTimeline(load: LoadTracker, opts: ReportOptions): Promise<TimelineEntry[]> {
  await load.idle();
  await nextFrame();
  await nextFrame();
  await load.idle();
  const timeline = load.timeline();
  window.loadTimeline = () => load.timeline();
  if (opts.perf) {
    console.log(`[load]\n${formatTimeline(timeline)}`);
    const end = Math.max(0, ...timeline.map((e) => e.end ?? 0));
    const longest = timeline.reduce<TimelineEntry | null>((a, e) => (!a || e.busy > a.busy ? e : a), null);
    const short = `load ${(end / 1000).toFixed(1)} s${longest ? ` (${longest.phase} ${(longest.busy / 1000).toFixed(1)} s)` : ""}`;
    opts.overlay?.setLabel(opts.label ? `${opts.label} · ${short}` : short);
  }
  return timeline;
}
