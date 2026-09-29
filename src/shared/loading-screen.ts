// The examples' loading screen: a reader of the engine's load tracker that draws something.
//
// The engine reports what is loading (`makeLoadTracker`: the renderer through `trackRenderer`,
// the generator pool, the instance layer, the chunked world and each page's own phases) and
// draws nothing. The page says what to show: a list of steps, each naming a tracker phase and
// the words for it, declared next to the page's loading code (`boot(name, { steps })` in its
// main.ts). Phases the list does not name are not shown, but stay on the tracker for
// `window.loadTimeline` and `?perf`. This file draws the list in two stages:
//
//   1. Until the page's first picture, a full-canvas overlay: the page title, one row per step in
//      the listed order (pending ones dimmed with no bar, a thin bar and `done/total` for a
//      counted phase, or the bar alone with `count: false`, a sliding bar for an uncounted one,
//      `n cached` (`cached` or `30% cached` with `count: false`), finished rows dimmed with a
//      tick; a background step says it continues in the background), and an overall bar over
//      the foreground steps. It fades in only after SHOW_AFTER_MS, so a page that is up sooner
//      never shows it at all.
//   2. From `ready()` on, the overlay fades out (and stops taking input at once) and a small pill
//      in the corner lists whatever listed step is still busy (`Building the ground 30/120`), for
//      streamed phases; the pill goes when they are idle.
//
// Events arrive synchronously, and a phase that blocks the main thread (an upload, the static
// placement, a pipeline compile) only reaches the screen once it has finished. The pages open an
// app phase and wait a frame (`step` / `nextFrame` in ./loading.ts) before such a step, so its
// row is on screen while it runs. The fades are opacity transitions, which the compositor runs
// during such a stall too.
//
// The test tools screenshot the canvas with every other element set `visibility: hidden`, so
// nothing here sets `visibility` (children inherit the hidden state), and the overlay is removed
// from the page once it has faded.

import { LOAD_PHASES, type LoadTracker, type PhaseState } from "@voxolith/engine";

/** Milliseconds before the overlay starts to fade in, so a quick load never flashes it. */
export const SHOW_AFTER_MS = 150;
/** Milliseconds a phase must stay busy after `ready()` before the corner pill shows it. */
const PILL_AFTER_MS = 150;
/** The fade-out, in ms (matches `.loading.leaving` in styles.css). */
const FADE_MS = 250;

/** One row of the loading screen: a phase of the page's tracker, and what to call it. */
export interface LoadingStep {
  /** The tracker phase the row reads: one of the engine's (`LOAD_PHASES`), `device`, or the page's own. */
  phase: string;
  /** The words shown for it. */
  label: string;
  /**
   * Work the page does not wait for (ground streamed after the first picture). It does not count
   * towards the overall bar; before `ready()` its row says it continues in the background, and
   * after it the corner pill shows it while it is busy.
   */
  background?: boolean;
  /**
   * Show the `done/total` numbers (default true). A phase counted in units nobody reads, such as
   * the bricks of an upload encoded on a worker (millions), sets it false: its row keeps the bar,
   * the time and what came from a cache as a share (`cached`, or `30% cached`), and the corner
   * pill shows only its label.
   */
  count?: boolean;
}

/**
 * Steps for the phases every page shares, in the examples' words. A page lists them as they are,
 * spreads one to change it (`{ ...STEPS.ground, background: true }`), or writes its own.
 */
export const STEPS = {
  /** `boot()`: the adapter and device. */
  device: { phase: "device", label: "Starting WebGPU" },
  /** The renderer's shader modules (`trackRenderer`). */
  shaders: { phase: LOAD_PHASES.shaders, label: "Linking shaders" },
  /** The renderer's pipelines (`trackRenderer`). */
  pipelines: { phase: LOAD_PHASES.pipelines, label: "Compiling pipelines" },
  /** Entities from the generator pool (or its cache). */
  models: { phase: LOAD_PHASES.models, label: "Generating models" },
  /** First-sight model uploads of an instance layer. */
  upload: { phase: LOAD_PHASES.upload, label: "Uploading models" },
  /**
   * The same, for a layer with a scene worker (`makeInstanceLayer(target, { worker })`): the
   * engine weights each model by its bricks, so the row shows the bar without the numbers.
   */
  encodedUpload: { phase: LOAD_PHASES.upload, label: "Uploading models", count: false },
  /** An instance layer's static placement. */
  placement: { phase: LOAD_PHASES.placement, label: "Placing instances" },
  /** Chunks of a chunked world. */
  ground: { phase: LOAD_PHASES.ground, label: "Building the ground" },
} as const satisfies Record<string, LoadingStep>;

/** Options for {@link showLoadingScreen}. */
export interface LoadingScreenOptions {
  /** The heading: the page's name. */
  title: string;
  /** The line under it. */
  blurb?: string;
  /**
   * The rows, in the order shown. Phases not listed are not shown (they are still on the
   * tracker); listed ones that have not started show as pending.
   */
  steps: readonly LoadingStep[];
  /** Where the overlay goes (default `#app`, else `body`); it covers this element. */
  parent?: HTMLElement;
}

/** The loading screen of a page, from {@link showLoadingScreen}. */
export interface LoadingScreen {
  /**
   * The page has drawn its first picture (or is about to: the overlay waits two frames). The
   * overlay stops taking input at once, fades out and is removed; listed steps still busy
   * afterwards show in the corner pill.
   */
  ready(): void;
  /**
   * Show a load failure instead of the progress: on the overlay (shown at once) before `ready()`,
   * in the pill after it. Uncaught errors and unhandled rejections before `ready()` call this.
   * The first failure stays up: if the page still gets to `ready()` (the error was not fatal),
   * the overlay goes and the failure moves to the pill.
   */
  fail(err: unknown): void;
  /**
   * Replace the steps, for a list that depends on what the page learnt after `boot` (the
   * valley's rats come only at some scales, and the scale depends on the GPU). Rows of phases
   * already under way keep their progress.
   */
  setSteps(steps: readonly LoadingStep[]): void;
  /** Remove the overlay and the pill and stop listening. */
  dispose(): void;
}

/** A screen that shows nothing, for pages that draw their own (minecraft-region before a drop). */
export const NO_SCREEN: LoadingScreen = { ready() {}, fail() {}, setSteps() {}, dispose() {} };

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/**
 * A phase's progress from 0 to 1: 0 before it starts, `done / total` when it is counted, else 0
 * while busy and 1 once it has ended.
 */
const fraction = (p: PhaseState | undefined) => (!p ? 0 : p.total > 0 ? p.done / p.total : p.busy ? 0 : 1);

/**
 * `12/40 · 5 cached`, with the phase's time once it has ended (if it took a tenth of a second or
 * more). Without the numbers the cached count is in the same unseen units, so it reads as a share:
 * `cached` when all of it came from a cache, else `30% cached`.
 */
function countText(p: PhaseState, numbers: boolean): string {
  const parts: string[] = [];
  if (numbers && p.total > 0) parts.push(`${p.done}/${p.total}`);
  if (p.cached > 0) {
    if (numbers) parts.push(`${p.cached} cached`);
    else if (p.total > 0 && p.cached < p.total) parts.push(`${Math.max(1, Math.min(99, Math.round((p.cached / p.total) * 100)))}% cached`);
    else parts.push("cached");
  }
  const secs = !p.busy && p.end !== undefined ? (p.end - p.start) / 1000 : 0;
  if (secs >= 0.1) parts.push(`${secs.toFixed(1)} s`);
  return parts.join(" · ");
}

const message = (err: unknown) =>
  err instanceof Error ? err.message || err.name : typeof err === "string" ? err : (() => { try { return JSON.stringify(err); } catch { return String(err); } })();

/**
 * Show `load` as the page's loading screen (see the file comment), with one row per step of
 * `opts.steps`. Call it before the load starts; call `ready()` once the page has drawn.
 *
 * @example
 * ```ts
 * const screen = showLoadingScreen(load, {
 *   title: "valley", blurb: "The valley, refined and streamed",
 *   steps: [
 *     { phase: "terrain", label: "Shaping the terrain" },
 *     STEPS.models,
 *     { ...STEPS.ground, background: true },
 *   ],
 * });
 * ```
 */
export function showLoadingScreen(load: LoadTracker, opts: LoadingScreenOptions): LoadingScreen {
  const parent = opts.parent ?? document.getElementById("app") ?? document.body;
  const hud = document.getElementById("hud");

  // --- the overlay -----------------------------------------------------------------------------
  const overlay = el("div", "loading");
  overlay.setAttribute("aria-busy", "true");
  const card = el("div", "loading-card");
  const head = el("div", "loading-head");
  const mark = el("img");
  mark.src = `${import.meta.env.BASE_URL}brand/logo-mark.svg`;
  mark.alt = "";
  const titles = el("div");
  titles.append(el("h1", "", opts.title));
  if (opts.blurb) titles.append(el("p", "loading-blurb", opts.blurb));
  head.append(mark, titles);
  const list = el("ol", "loading-phases");
  const overall = el("div", "loading-overall");
  const overallBar = el("span", "loading-bar");
  const overallFill = el("i");
  overallBar.append(overallFill);
  overall.setAttribute("role", "progressbar");
  overall.setAttribute("aria-label", "Loading");
  overall.setAttribute("aria-valuemin", "0");
  overall.setAttribute("aria-valuemax", "100");
  overall.append(el("span", "loading-name", "Overall"), overallBar);
  const error = el("div", "loading-error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  card.append(head, list, overall, error);
  overlay.append(card);
  parent.insertBefore(overlay, hud && hud.parentElement === parent ? hud : null);
  // Flush the transparent start, so the fade-in below is a transition (it waits SHOW_AFTER_MS).
  void overlay.getBoundingClientRect();
  overlay.classList.add("in");

  // --- the corner pill -------------------------------------------------------------------------
  const pill = el("div", "loading-pill");
  pill.setAttribute("role", "status");
  const pillText = el("span");
  pill.append(el("i"), pillText);
  (hud ?? parent).append(pill);

  interface Row { step: LoadingStep; li: HTMLLIElement; mark: HTMLElement; count: HTMLElement; fill: HTMLElement }
  let rows: Row[] = [];
  /** Build the rows for `steps`, in their order, replacing any there were. */
  function layOut(steps: readonly LoadingStep[]): void {
    list.replaceChildren();
    rows = steps.map((step) => {
      const li = el("li", "loading-row pending");
      li.classList.toggle("background", !!step.background);
      const m = el("span", "loading-mark");
      const name = el("span", "loading-name", step.label);
      if (step.background) name.append(el("small", "loading-note", "continues in the background"));
      const count = el("span", "loading-count");
      const bar = el("span", "loading-bar");
      const fill = el("i");
      bar.append(fill);
      li.append(m, name, count, bar);
      list.append(li);
      return { step, li, mark: m, count, fill };
    });
  }
  layOut(opts.steps);

  let stage: "loading" | "ready" | "gone" = "loading";
  /** The failure shown, once `fail` was called: it stays up, on the overlay or in the pill. */
  let failure: string | null = null;
  let queued = 0;
  let pillTimer: ReturnType<typeof setTimeout> | undefined;

  const phasesNow = () => new Map(load.snapshot().phases.map((p) => [p.phase, p]));

  function drawOverlay(): void {
    const phases = phasesNow();
    let sum = 0, counted = 0;
    for (const row of rows) {
      const p = phases.get(row.step.phase);
      row.li.classList.toggle("pending", !p);
      row.li.classList.toggle("busy", !!p?.busy);
      row.li.classList.toggle("done", !!p && !p.busy);
      row.li.classList.toggle("counted", !!p && p.total > 0);
      row.mark.textContent = p && !p.busy ? "✓" : "";
      row.count.textContent = p ? countText(p, row.step.count !== false) : "";
      row.fill.style.transform = `scaleX(${fraction(p)})`;
      if (!row.step.background) { sum += fraction(p); counted++; }
    }
    // Overall: the mean of the foreground steps' fractions, pending ones at 0, unweighted (a
    // model and a chunk are not worth the same, and nothing here knows how much each costs). It
    // only moves backwards when a counted phase's total grows; that is what is known, and it is
    // not smoothed over.
    const all = counted ? sum / counted : 0;
    overallFill.style.transform = `scaleX(${all})`;
    overall.setAttribute("aria-valuenow", String(Math.round(all * 100)));
  }

  /** The listed steps busy now, with their phases. */
  const busyRows = () => {
    const phases = phasesNow();
    return rows.flatMap((row) => {
      const p = phases.get(row.step.phase);
      return p?.busy ? [{ step: row.step, p }] : [];
    });
  };

  function drawPill(): void {
    if (failure !== null) return;
    const busy = busyRows();
    if (!busy.length) {
      clearTimeout(pillTimer);
      pillTimer = undefined;
      pill.classList.remove("on");
      return;
    }
    pillText.textContent = busy.map(({ step, p }) => `${step.label}${p.total > 0 && step.count !== false ? ` ${p.done}/${p.total}` : ""}`).join(" · ");
    if (!pill.classList.contains("on") && pillTimer === undefined) {
      // Only a step that stays busy for a while earns the pill; a quick one (a pipeline variant
      // compiled on the first frame) would only blink.
      pillTimer = setTimeout(() => {
        pillTimer = undefined;
        if (busyRows().length) pill.classList.add("on");
      }, PILL_AFTER_MS);
    }
  }

  const draw = () => {
    queued = 0;
    if (stage === "loading" && failure === null) drawOverlay();
    else if (stage === "ready") drawPill();
  };
  // Many events a frame (a chunk, a model each): draw once per frame.
  const off = load.on(() => {
    if (!queued) queued = requestAnimationFrame(draw);
  });
  draw();

  const onError = (e: ErrorEvent) => screen.fail(e.error ?? e.message);
  const onRejection = (e: PromiseRejectionEvent) => screen.fail(e.reason);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  const unhook = () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
  const shownAt = performance.now() + SHOW_AFTER_MS;
  const showFailureInPill = () => {
    clearTimeout(pillTimer);
    pillText.textContent = failure;
    pill.classList.add("on", "failed");
  };

  const screen: LoadingScreen = {
    ready() {
      if (stage !== "loading") return;
      stage = "ready";
      unhook();
      if (import.meta.env.DEV) {
        // A foreground step that never ran is a list out of step with the page's load.
        const phases = phasesNow();
        const missed = rows.filter((r) => !r.step.background && !phases.has(r.step.phase)).map((r) => r.step.phase);
        if (missed.length) console.warn(`[loading] listed steps that never started before ready(): ${missed.join(", ")}`);
      }
      overlay.removeAttribute("aria-busy");
      overlay.classList.add("through");
      // Two frames: the page's first picture is presented before the overlay starts to go.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (stage === "gone") return;
        // Never faded in (a quick page): just take it away.
        if (performance.now() < shownAt) overlay.remove();
        else {
          overlay.classList.add("leaving");
          setTimeout(() => overlay.remove(), FADE_MS + 50);
        }
      }));
      // A page that still got to its picture after a failure (the error was not fatal) is
      // shown, with the failure kept in the pill.
      if (failure !== null) showFailureInPill();
      else drawPill();
    },
    fail(err) {
      if (stage === "gone" || failure !== null) return;
      failure = `Loading failed: ${message(err)}`;
      console.error("[loading]", err);
      if (stage === "loading") {
        overlay.removeAttribute("aria-busy");
        drawOverlay();
        overlay.classList.add("now", "failed");
        error.textContent = failure;
        error.hidden = false;
      } else showFailureInPill();
    },
    setSteps(steps) {
      if (stage === "gone") return;
      layOut(steps);
      if (stage === "loading") drawOverlay();
      else drawPill();
    },
    dispose() {
      if (stage === "gone") return;
      stage = "gone";
      off();
      unhook();
      if (queued) cancelAnimationFrame(queued);
      clearTimeout(pillTimer);
      overlay.remove();
      pill.remove();
    },
  };
  return screen;
}
