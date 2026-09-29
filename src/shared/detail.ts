// Coarse first, one swap: how valley and nightwood show a scene before its fine models exist.
//
// Every entity generator builds the same design at 10 voxels per metre (natively, the fastest)
// and finer (20, 50, 100), with the same extent and anchor, and the finer model stays within one
// native voxel of the native one. So a page at 50 or 100 vox/m first places the 10 vox/m models,
// each drawn 5 or 10 times enlarged (the engine's `EntityPlacement.scale`, the renderer's scaled
// models), shows that, and generates, encodes and bakes the fine set in the background. The
// instance layer keeps the coarse set drawing until the fine set's bake applies, then releases
// the coarse models (`setStatic` + `commitAsync` in one task), so the swap is one frame.
//
// It is a choice, not a default of the engine: the fine stage is a second generation, upload and
// bake that run while the user is already in the scene, so the scene takes longer to finish and
// the frames during the swap cost more. On a desktop that buys a first picture in a fraction of
// the time; on a phone the background work lags the scene for longer than it saves, so the
// examples load phones in one stage. Each page picks with a `COARSE_FIRST` switch at its top.
//
// This file holds the parts both pages share, and is the piece to copy into an app that wants
// the routine: the factor, the phase names of the fine stage (so the load timeline tells the
// stages apart, and the loading screen lists them as background rows), the tracker that files the
// loaders' phases under them, and the swap itself. Nothing in it runs unless a page asks for it:
// with a factor of 1 a page loads its fine models once and never calls the rest.

import type { InstanceLayer, LoadTracker } from "@voxolith/engine";
import { LOAD_PHASES } from "@voxolith/engine";
import { commitStatic } from "./placement";
import { STEPS, type LoadingStep } from "./loading-screen";

/** The scale the coarse stage is generated at: the generators' native 10 voxels per metre. */
export const COARSE_VPM = 10;

/**
 * The factor the coarse models are drawn enlarged by at `vpm`, or 1 for no coarse stage.
 *
 * `enabled` is the page's own choice (its `COARSE_FIRST` switch for this device). Even then only
 * 50 and 100 vox/m get one (factors 5 and 10). At 20 the factor would be 2: the fine models
 * there cost about a tenth of those at 50 and the page is up in about 2 s warm, most of it the
 * terrain and ground, which a coarse stage does not shorten; a second upload and bake would only
 * add work. The URL overrides both: `?coarse=0` turns the stage off, `?coarse=1` on at any scale
 * that is a multiple of 10 (at 20 too, factor 2), to compare or to test it on a phone.
 */
export function coarseFactor(vpm: number, params: URLSearchParams, enabled: boolean): number {
  const asked = params.get("coarse");
  const on = asked === "1" ? true : asked === "0" ? false : enabled && vpm >= 50;
  return on && vpm > COARSE_VPM && vpm % COARSE_VPM === 0 ? vpm / COARSE_VPM : 1;
}

/** The fine stage's phases: the engine's own, filed under a name of their own. */
export const FINE_PHASES = {
  models: `fine.${LOAD_PHASES.models}`,
  upload: `fine.${LOAD_PHASES.upload}`,
  placement: `fine.${LOAD_PHASES.placement}`,
} as const;

/** The mark the pages set when the fine set is drawing (the swap). */
export const FINE_MARK = "fine";

/**
 * The fine stage's rows: after the first picture they show in the corner pill while busy (before
 * it, they say they continue in the background).
 */
export const FINE_STEPS: readonly LoadingStep[] = [
  { phase: FINE_PHASES.models, label: "Generating detail", background: true },
  { phase: FINE_PHASES.upload, label: "Uploading detail", background: true, count: false },
  { phase: FINE_PHASES.placement, label: "Placing detail", background: true },
];

/** The coarse stage's rows: the shared steps, named for what they carry. */
export const COARSE_STEPS = {
  models: { ...STEPS.models, label: "Generating coarse models" },
  upload: { ...STEPS.encodedUpload, label: "Uploading coarse models" },
  placement: STEPS.placement,
} as const satisfies Record<string, LoadingStep>;

/** A tracker for the loaders, from {@link stagedLoad}: switch its phases to the fine stage with `fine()`. */
export interface StagedLoad {
  /** Give this to the generator pool and the instance layer instead of the page's tracker. */
  readonly tracker: LoadTracker;
  /**
   * From now on, tasks the loaders open on these phases (default: `models`, `upload` and
   * `placement`) go under {@link FINE_PHASES}. Tasks already open stay where they are.
   */
  fine(...phases: (keyof typeof FINE_PHASES)[]): void;
}

/**
 * Wrap the page's tracker so the loaders' phases can be filed per stage. The pool opens a
 * `models` task per request as it is queued, the layer an `upload` task per model it sends to be
 * encoded (in `setStatic`) and a `placement` task per bake. So switching `models` just before the
 * fine requests, and `upload` and `placement` just before the fine `setStatic`
 * ({@link swapToFine} does), files all of the fine stage's work and nothing of the coarse one's.
 * Everything else (marks, listeners, the timeline) is the page's tracker.
 */
export function stagedLoad(load: LoadTracker): StagedLoad {
  const fine = new Set<string>();
  const names: Record<string, string> = FINE_PHASES;
  const tracker: LoadTracker = {
    task: (phase, total) => load.task(fine.has(phase) ? names[phase] : phase, total),
    on: (fn) => load.on(fn),
    snapshot: () => load.snapshot(),
    idle: (phase) => load.idle(phase),
    timeline: () => load.timeline(),
    mark: (name, t) => load.mark(name, t),
    marks: () => load.marks(),
    onMark: (fn) => load.onMark(fn),
    now: () => load.now(),
    get origin() {
      return load.origin;
    },
  };
  return {
    tracker,
    fine(...phases) {
      for (const p of phases.length ? phases : (Object.keys(FINE_PHASES) as (keyof typeof FINE_PHASES)[])) fine.add(p);
    },
  };
}

/**
 * The swap: replace the coarse static set with the fine one and wait until it draws. `setStatic`
 * and the commit run in one task, so a crowd's per-frame `commit()` cannot place the fine set
 * synchronously in between; the coarse set draws until the fine bake applies, and its models are
 * released right after. Files the layer's phases under {@link FINE_PHASES} first, and marks
 * {@link FINE_MARK} once the fine set is drawing.
 */
export async function swapToFine(staged: StagedLoad, layer: InstanceLayer, statics: Parameters<InstanceLayer["setStatic"]>[0]): Promise<void> {
  staged.fine("upload", "placement");
  layer.setStatic(statics);
  await commitStatic(layer);
  staged.tracker.mark(FINE_MARK);
}
