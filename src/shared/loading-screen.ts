// The examples' loading screen: a reader of the engine's load tracker that draws something.
//
// The engine reports what is loading (`makeLoadTracker`: the renderer through `trackRenderer`,
// the generator pool, the instance layer, the chunked world and each page's own phases) and
// draws nothing. This file draws it in two stages:
//
//   1. Until the page's first picture, a full-canvas overlay: the page title, one row per phase
//      in the order it started (its words from ./loading-labels.ts, a thin bar and `done/total`
//      for a counted phase, a sliding bar for an uncounted one, `n cached`), finished rows dimmed
//      with a tick, and an overall bar. It fades in only after SHOW_AFTER_MS, so a page that is
//      up sooner never shows it at all.
//   2. From `ready()` on, the overlay fades out (and stops taking input at once) and a small pill
//      in the corner lists whatever is still busy (`Building the ground 30/120`), for streamed
//      phases; the pill goes when the tracker is idle.
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

import type { LoadTracker, PhaseState } from "@voxolith/engine";
import { PAGE_BLURBS, phaseLabel } from "./loading-labels";

/** Milliseconds before the overlay starts to fade in, so a quick load never flashes it. */
export const SHOW_AFTER_MS = 150;
/** Milliseconds a phase must stay busy after `ready()` before the corner pill shows it. */
const PILL_AFTER_MS = 150;
/** The fade-out, in ms (matches `.loading.leaving` in styles.css). */
const FADE_MS = 250;

/** Options for {@link showLoadingScreen}. */
export interface LoadingScreenOptions {
  /** The heading: the page's name. */
  title: string;
  /** The line under it; defaults to the page's entry in `PAGE_BLURBS` (by `title`). */
  blurb?: string;
  /** Where the overlay goes (default `#app`, else `body`); it covers this element. */
  parent?: HTMLElement;
}

/** The loading screen of a page, from {@link showLoadingScreen}. */
export interface LoadingScreen {
  /**
   * The page has drawn its first picture (or is about to: the overlay waits two frames). The
   * overlay stops taking input at once, fades out and is removed; phases still busy afterwards
   * show in the corner pill.
   */
  ready(): void;
  /**
   * Show a load failure instead of the progress: on the overlay (shown at once) before `ready()`,
   * in the pill after it. Uncaught errors and unhandled rejections before `ready()` call this.
   * The first failure stays up: if the page still gets to `ready()` (the error was not fatal),
   * the overlay goes and the failure moves to the pill.
   */
  fail(err: unknown): void;
  /** Remove the overlay and the pill and stop listening. */
  dispose(): void;
}

/** A screen that shows nothing, for pages that draw their own (minecraft-region before a drop). */
export const NO_SCREEN: LoadingScreen = { ready() {}, fail() {}, dispose() {} };

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/**
 * A phase's progress from 0 to 1: `done / total` when it is counted, else 0 while busy and 1
 * once it has ended.
 */
const fraction = (p: PhaseState) => (p.total > 0 ? p.done / p.total : p.busy ? 0 : 1);

/** `12/40 · 5 cached`, with the phase's time once it has ended (if it took a tenth of a second or more). */
function countText(p: PhaseState): string {
  const parts: string[] = [];
  if (p.total > 0) parts.push(`${p.done}/${p.total}`);
  if (p.cached > 0) parts.push(`${p.cached} cached`);
  const secs = !p.busy && p.end !== undefined ? (p.end - p.start) / 1000 : 0;
  if (secs >= 0.1) parts.push(`${secs.toFixed(1)} s`);
  return parts.join(" · ");
}

const message = (err: unknown) =>
  err instanceof Error ? err.message || err.name : typeof err === "string" ? err : (() => { try { return JSON.stringify(err); } catch { return String(err); } })();

/**
 * Show `load` as the page's loading screen (see the file comment). Call it before the load
 * starts; call `ready()` once the page has drawn.
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
  const blurb = opts.blurb ?? PAGE_BLURBS[opts.title];
  if (blurb) titles.append(el("p", "loading-blurb", blurb));
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

  const rows = new Map<string, { li: HTMLLIElement; mark: HTMLElement; count: HTMLElement; fill: HTMLElement }>();
  let stage: "loading" | "ready" | "gone" = "loading";
  /** The failure shown, once `fail` was called: it stays up, on the overlay or in the pill. */
  let failure: string | null = null;
  let queued = 0;
  let pillTimer: ReturnType<typeof setTimeout> | undefined;

  function drawOverlay(): void {
    const snap = load.snapshot();
    for (const p of snap.phases) {
      let row = rows.get(p.phase);
      if (!row) {
        const li = el("li", "loading-row");
        const m = el("span", "loading-mark");
        const count = el("span", "loading-count");
        const bar = el("span", "loading-bar");
        const fill = el("i");
        bar.append(fill);
        li.append(m, el("span", "loading-name", phaseLabel(p.phase)), count, bar);
        list.append(li);
        row = { li, mark: m, count, fill };
        rows.set(p.phase, row);
      }
      row.li.classList.toggle("busy", p.busy);
      row.li.classList.toggle("done", !p.busy);
      row.li.classList.toggle("counted", p.total > 0);
      row.mark.textContent = p.busy ? "" : "✓";
      row.count.textContent = countText(p);
      row.fill.style.transform = `scaleX(${fraction(p)})`;
    }
    // Overall: the mean of the phases' fractions, over the phases seen so far, unweighted (a
    // model and a chunk are not worth the same, and nothing here knows how much each costs).
    // So it moves backwards when a new phase starts; that is what is known, and it is not
    // smoothed over.
    const all = snap.phases.length ? snap.phases.reduce((a, p) => a + fraction(p), 0) / snap.phases.length : 0;
    overallFill.style.transform = `scaleX(${all})`;
    overall.setAttribute("aria-valuenow", String(Math.round(all * 100)));
  }

  function drawPill(): void {
    if (failure !== null) return;
    const busy = load.snapshot().phases.filter((p) => p.busy);
    if (!busy.length) {
      clearTimeout(pillTimer);
      pillTimer = undefined;
      pill.classList.remove("on");
      return;
    }
    pillText.textContent = busy.map((p) => `${phaseLabel(p.phase)}${p.total > 0 ? ` ${p.done}/${p.total}` : ""}`).join(" · ");
    if (!pill.classList.contains("on") && pillTimer === undefined) {
      // Only a phase that stays busy for a while earns the pill; a quick one (a pipeline variant
      // compiled on the first frame) would only blink.
      pillTimer = setTimeout(() => {
        pillTimer = undefined;
        if (load.snapshot().busy) pill.classList.add("on");
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
