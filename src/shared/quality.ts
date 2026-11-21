// The renderer's quality, from a page's options: one place that reads RENDER_OPTIONS
// (./options.ts), sets `renderer.setQuality` and applies the panel's changes live, so every page
// offers the same knobs the same way. The page says only what is its own: the preset this device
// starts on and the step caps its scene needs.
//
// It is also where the phone profile reaches the renderer (`PHONE` below; the page's `phone` flag
// comes from ./scale.ts `phoneProfile`). A phone GPU walks rays 20 to 90 times slower per pixel
// than a desktop's (measured on an Adreno 725), and what that cost follows is the number of rays
// and their steps, not the shading. So a phone traces fewer rays: temporal accumulation on, the
// scene traced at a fraction of the output (`RenderQuality.upscale`) and resolved to it over
// frames, and that fraction adapted to the frame time (`makeTracedFraction`). Temporal upscaling
// is the renderer's, after Brian Karis, "High Quality Temporal Supersampling" (SIGGRAPH 2014,
// Advances in Real-Time Rendering course).

import { QUALITY_PRESETS, type GpuContext, type QualityPreset, type RenderQuality, type Renderer } from "@voxolith/renderer";
import type { PageOptions, RENDER_OPTIONS } from "./options";
import { prepared } from "./loading";

/**
 * The phone profile's renderer settings: the defaults `applyRenderOptions` uses where the page
 * says `phone`. Each is the default of an option in the panel, so the URL or the panel overrides
 * any of them, and `?full` all of them.
 */
export const PHONE = {
  /**
   * Medium, not Low: temporal accumulation and the traced fraction need shadows or AO to be on
   * (the renderer ignores both otherwise), and with them accumulated a still view costs about the
   * primary rays alone, as Low does.
   */
  preset: "medium" as QualityPreset,
  /** Shadows and AO kept across frames; what the traced fraction builds on. */
  temporal: true,
  /** No secondary rays: compiled out, every pixel is cheaper (a third on the phone measured). */
  reflections: false,
  /**
   * The output's render scale, of a pixel ratio the engine caps at 2: 1.2 device pixels per CSS
   * pixel, 471x875 on a 393x729 screen. The resolve to it is cheap (0.6 ms on the phone
   * measured); what costs is the traced size below.
   */
  outputScale: 0.6,
  /**
   * The primary step cap where the page's `tweak` gives none: Low's. Small scenes end their rays
   * well before it; it bounds the grazing rays that would otherwise walk the whole grid.
   */
  maxSteps: 256,
  /** The frame time the traced fraction is steered towards: 60 fps. */
  targetMs: 1000 / 60,
  /**
   * The lowest traced fraction: 0.35 of the output each way, an eighth of its pixels (165x306
   * for the output above). The renderer goes to 0.25, but there fine detail does not come back
   * between two camera moves and the picture reads as a blur; a page that cannot hold 60 fps at
   * the floor runs slower rather than softer.
   */
  floor: 0.35,
  /** Where the controller starts: low, so the first seconds are fluid, and up from there. */
  start: 0.35,
} as const;

/**
 * The traced fractions the controller moves between: about 1.4 times the pixels from one to the
 * next. Few, far apart levels are the first guard against hunting: every change restarts the
 * resolve, which shows as a second of softness.
 */
const LEVELS = [0.25, 0.3, 0.35, 0.42, 0.5, 0.6, 0.7, 0.85, 1] as const;
/** Frames after a change before the controller judges again: the GPU average (0.9 a frame) and the converging burst have settled. */
const SETTLE_FRAMES = 45;
/** How often the controller judges. */
const JUDGE_MS = 500;
/** Judgements in a row before it steps down (1 s) or up (2 s). */
const DOWN_AFTER = 2, UP_AFTER = 4;
/** A fraction that proved too slow is not tried again for this long. */
const RETRY_MS = 60_000;
/** The share of the frame budget the GPU passes may take; the rest is the page's CPU work and the compositor. */
const GPU_SHARE = 0.85;

/** What {@link makeTracedFraction} is given. */
export interface TracedFractionOptions {
  /** The lowest fraction it goes to. */
  floor: number;
  /** Where it starts. */
  start: number;
  /** The frame time to aim at, in milliseconds. */
  targetMs: number;
  /** The GPU milliseconds of a frame, all passes summed and averaged over frames, or null without timestamp queries. */
  gpuMs: () => number | null;
}

/** The controller of the traced fraction. */
export interface TracedFraction {
  /** Call once per rendered frame with its time; returns the fraction to trace at. */
  frame(now: number): number;
  /** The fraction now. */
  value(): number;
  /** Smoothed time between rendered frames, in milliseconds. */
  frameMs(): number;
  /** How often the fraction has changed. */
  changes(): number;
}

/**
 * Steer the traced fraction (`RenderQuality.upscale`) towards a frame time, without hunting.
 *
 * The rules:
 * - It reads GPU milliseconds where the device has timestamp queries. Frame gaps come in whole
 *   vsync intervals, so a frame that just fits reads the same as one with room to spare, and a
 *   controller on gaps alone must probe to find out; GPU time says how much room there is, and
 *   tracing costs in proportion to the pixels, so the fraction that fits can be computed and
 *   taken in one step.
 * - Down: over the budget for a second, it drops straight to the fraction predicted to fit, and
 *   remembers the one it left as too slow for a minute.
 * - Up: only when the next fraction is predicted to fit with a tenth to spare, held for two
 *   seconds, and never to one remembered as too slow. Between "fits" and "the next would fit"
 *   lies a band of about 1.7 times in cost in which nothing changes, so a scene whose cost
 *   wanders (a crowd, weather, the view turning) stays where it is.
 * - After a change it waits 45 frames before judging again.
 * - Without timestamp queries it falls back to frame gaps, as `makePerf` does: down when the
 *   smoothed gap is a quarter over, up one level at a time when it fits, with the same memory.
 *
 * It never goes below `floor`: there the page runs slower instead.
 */
export function makeTracedFraction(opts: TracedFractionOptions): TracedFraction {
  const levels = LEVELS.filter((l) => l >= opts.floor - 1e-6);
  let level: number = levels.reduce((best, l) => (Math.abs(l - opts.start) < Math.abs(best - opts.start) ? l : best));
  let ceiling = Infinity, ceilingAt = 0;
  let last = 0, ema = opts.targetMs, frames = 0, judged = 0, over = 0, under = 0, changes = 0;
  /** The highest level at or under `want` (the floor if none). */
  const atMost = (want: number) => levels.reduce((best, l) => (l <= want + 1e-6 && l > best ? l : best), levels[0]);
  const below = (l: number) => levels[Math.max(0, levels.indexOf(l as (typeof LEVELS)[number]) - 1)];
  const above = (l: number) => levels[Math.min(levels.length - 1, levels.indexOf(l as (typeof LEVELS)[number]) + 1)];
  const set = (next: number, now: number) => {
    if (next < level) { ceiling = level; ceilingAt = now; }
    level = next;
    frames = over = under = 0;
    changes++;
  };
  function frame(now: number): number {
    const dt = now - last;
    last = now;
    // Gaps (tab hidden, render on demand idling) are not render cost.
    if (dt > 0 && dt < 250) ema += (dt - ema) * 0.2;
    frames++;
    if (frames < SETTLE_FRAMES || now - judged < JUDGE_MS) return level;
    judged = now;
    if (ceiling !== Infinity && now - ceilingAt > RETRY_MS) ceiling = Infinity;
    const gpu = opts.gpuMs();
    const up = above(level), allowed = up > level && up < ceiling - 1e-6;
    if (gpu !== null && gpu > 0) {
      // The load: 1 is the whole of the GPU's share of the budget.
      const load = gpu / (opts.targetMs * GPU_SHARE);
      if (load > 1.1 && level > levels[0]) {
        under = 0;
        if (++over >= DOWN_AFTER) set(Math.min(below(level), atMost(level / Math.sqrt(load))), now);
      } else if (allowed && load * (up / level) ** 2 < 0.9) {
        over = 0;
        if (++under >= UP_AFTER) {
          const fits = atMost(level * Math.sqrt(0.9 / load));
          set(Math.max(up, Math.min(fits, ceiling === Infinity ? 1 : below(ceiling))), now);
        }
      } else over = under = 0;
    } else if (ema > opts.targetMs * 1.25 && level > levels[0]) {
      under = 0;
      // Under vsync a frame that barely misses reads as two intervals: only a clearly slower one
      // justifies more than one level.
      if (++over >= DOWN_AFTER) set(ema < opts.targetMs * 2.3 ? below(level) : Math.min(below(level), atMost(level * Math.sqrt(opts.targetMs / ema))), now);
    } else if (allowed && ema < opts.targetMs * 1.05) {
      over = 0;
      if (++under >= UP_AFTER) set(up, now);
    } else over = under = 0;
    return level;
  }
  return { frame, value: () => level, frameMs: () => ema, changes: () => changes };
}

/** What a page gives {@link applyRenderOptions}. */
export interface RenderSetup {
  /** The page's device, for the phone profile and the adaptive traced fraction (without it neither applies). */
  gpu?: GpuContext;
  /** Whether this load gets the phone profile (./scale.ts `phoneProfile`). A CPU adapter never does: it keeps `preset`. */
  phone?: boolean;
  /** The preset on this device when the URL names none (Low on a CPU adapter, as every page does); a phone gets `PHONE.preset`. */
  preset: QualityPreset;
  /** The page's own changes to a preset: step caps for its scene's size. `phone` says the phone profile applies. */
  tweak?: (preset: QualityPreset, phone: boolean) => Partial<RenderQuality>;
  /** The page's defaults where they differ from the presets' (temporal off, reflections on, upscale 1). */
  temporal?: boolean;
  reflections?: boolean;
  upscale?: number;
  /**
   * The page's subject moves all the time (an animated creature, a crowd, a chase camera). Where
   * the frame time is adapted to, the page is then drawn smaller as a whole instead of traced
   * smaller and resolved to a fixed output: the resolve builds its sharpness from frames in which
   * a surface stays put, and what moves under it smears (looked at side by side: a walking rat is
   * a blur at a traced fraction of 0.5 and crisp at the same number of rays drawn plainly).
   */
  moving?: boolean;
  /** Called after a live change, to redraw (and restart whatever the page measures). */
  changed?: () => void;
}

/** What the page reads back. */
export interface RenderControls {
  /** The preset in use. */
  preset(): QualityPreset;
  /** The fixed render scale asked for, or 0 for the page's own (adaptive) one. */
  fixedScale(): number;
  /**
   * Whether the traced fraction adapts to the frame time (a phone's default, or `?upscale=0`
   * anywhere). The render scale is then this module's, so a page with `makePerf` passes this as
   * its `locked`.
   */
  adaptive(): boolean;
  /**
   * Once per rendered frame, before `resizeToDisplay`: returns the render scale to draw at
   * (`?renderScale=` if given, else `own`, the page's, capped at `PHONE.outputScale` on a phone)
   * and steps the traced fraction where it adapts (for a `moving` page the fraction is of the
   * render scale itself). On a desktop it is `fixedScale() || own`.
   */
  pace(now: number, own: number): number;
}

type Keys = keyof typeof RENDER_OPTIONS;
/** A page's options that include the shared render options (all of them, or all but those in `omit`). */
type RenderPageOptions<O extends Keys> = PageOptions<Omit<typeof RENDER_OPTIONS, O>>;

/** What `window.renderPace()` returns, for the tools and for judging the profile on a device. */
export interface PaceReport {
  phone: boolean;
  adaptive: boolean;
  /** How the fraction is applied: traced smaller and resolved to the output, or (a `moving` page) the output drawn smaller. */
  mode: "upscale" | "scale";
  /** The traced fraction in use, of the output at the profile's scale (1 where nothing is reduced). */
  traced: number;
  /** How often the controller changed it. */
  changes: number;
  fps: number;
  /** GPU milliseconds per frame, all passes, the renderer's running average; null without timestamp queries. */
  gpuMs: number | null;
  output: [number, number];
  quality: RenderQuality;
}

/** The one readout of the page (a page may build more than one renderer, one after the other). */
let readout: HTMLElement | null = null;

/**
 * Set the renderer's quality from the page's options and keep it in step with the panel. Call it
 * before `renderer.prepare()`, which compiles the pipelines the quality needs. `omit` names shared
 * options the page did not declare (instances has an `?upscale=` of its own).
 *
 * With `phone` (and a GPU adapter) the defaults are the phone profile's, `PHONE`: its preset,
 * temporal accumulation on, reflections off, the output at 0.6 and the traced fraction adapted to
 * the frame time. Every option given in the URL still wins, and without `phone` nothing differs
 * from the page's own setup.
 *
 * @example
 * ```ts
 * const phone = phoneProfile(gpu, options);
 * const render = applyRenderOptions(options, renderer, { gpu, phone, preset: gpu.software ? "low" : "medium", changed: () => loop.invalidate() });
 * // per frame:
 * gpu.renderScale = render.pace(now, perf.scale());
 * ```
 */
export function applyRenderOptions<O extends Keys = never>(page: RenderPageOptions<O>, renderer: Renderer, setup: RenderSetup, omit: readonly O[] = []): RenderControls {
  const options = page as unknown as PageOptions<typeof RENDER_OPTIONS>;
  const has = (key: Keys) => !(omit as readonly Keys[]).includes(key);
  const gpu = setup.gpu;
  /** The phone profile, where it applies. */
  const P = setup.phone && gpu && !gpu.software ? PHONE : null;
  const preset = () => options.get("quality", P ? P.preset : setup.preset);
  /** The traced fraction asked for: 0 is "adapt it". */
  const asked = () => (has("upscale") ? options.get("upscale", P ? 0 : (setup.upscale ?? 1)) : P ? 0 : (setup.upscale ?? 1));
  const debug = () => (has("debug") ? options.get("debug") : 0);
  /** `?phone=45`: the controller reads the GPU time that many times longer (a slower GPU's decisions on this one). */
  const slow = has("phone") ? Math.max(1, Number(options.get("phone")) || 1) : 1;
  const gpuMs = () => {
    const t = renderer.gpuTimings();
    const sum = t ? Object.values(t).reduce((a, b) => a + b, 0) : 0;
    return sum > 0 ? sum : null;
  };
  const pacer = makeTracedFraction({ floor: PHONE.floor, start: PHONE.start, targetMs: PHONE.targetMs, gpuMs: () => { const g = gpuMs(); return g === null ? null : g * slow; } });
  const moving = !!setup.moving;
  const fixedScale = () => (has("renderScale") ? options.get("renderScale") : 0);
  const quality = (): RenderQuality => {
    const p = preset();
    const q: RenderQuality = {
      ...QUALITY_PRESETS[p],
      ...(P ? { maxSteps: Math.min(QUALITY_PRESETS[p].maxSteps, P.maxSteps) } : {}),
      ...setup.tweak?.(p, !!P),
      temporal: has("temporal") ? options.get("temporal", P ? P.temporal : (setup.temporal ?? false)) : P ? P.temporal : (setup.temporal ?? false),
      reflections: has("reflections") ? options.get("reflections", P ? P.reflections : (setup.reflections ?? true)) : P ? P.reflections : (setup.reflections ?? true),
      upscale: asked() || (moving ? 1 : pacer.value()),
    };
    // Temporal accumulation has nothing to keep without shadows or AO (the Low preset): the
    // renderer ignores it there, and asking for it would only compile its kernels.
    if (!(q.shadowSteps > 0 || q.ao)) q.temporal = false;
    return q;
  };
  /**
   * Whether the fraction adapts: asked for (0), and it can take effect. Traced and resolved, that
   * needs the renderer to upscale at all (temporal accumulation with something to accumulate, and
   * no debug view); for a `moving` page, that no render scale is pinned.
   */
  const adapts = (q: RenderQuality) => !!gpu && asked() === 0 && (moving ? !fixedScale() : q.temporal && (q.shadowSteps > 0 || q.ao) && debug() === 0);
  let q = quality();
  let adaptive = adapts(q);
  // Not adapting, "0" has nothing to stand for: trace at full size.
  if (!adaptive && asked() === 0) q = { ...q, upscale: 1 };
  renderer.setQuality(q);
  // The output starts at the profile's scale, so a page's makePerf (made after this) starts there too.
  if (P && gpu) gpu.renderScale = Math.min(gpu.renderScale, P.outputScale);
  // A change of temporal or reflections needs pipelines of its own: compile them first, so the
  // frame that switches does not stall on it.
  const apply = () => {
    let next = quality();
    const a = adapts(next);
    if (!a && asked() === 0) next = { ...next, upscale: 1 };
    void prepared(renderer.prepare({ temporal: next.temporal, reflections: next.reflections })).then(() => {
      q = next;
      adaptive = a;
      renderer.setQuality(q);
      setup.changed?.();
    });
  };
  for (const key of ["quality", "temporal", "reflections", "upscale"] as const) if (has(key)) options.on(key, apply);
  // (Where the fraction adapts, pinning the render scale may switch that off: worked out again.)
  if (has("renderScale")) options.on("renderScale", () => { if (P || asked() === 0) apply(); else setup.changed?.(); });
  if (has("debug")) {
    if (options.get("debug")) renderer.setDebug(options.get("debug"));
    // A debug view draws without upscaling, so where the fraction adapts it is worked out again.
    options.on("debug", (v) => { renderer.setDebug(v); if (P || asked() === 0) apply(); else setup.changed?.(); });
  }

  // The readout: ?perf on a phone (or wherever the fraction adapts) shows the frame rate and the
  // traced fraction, small, as the last line of the HUD's bar (clear of the pages' bottom
  // controls, the touch sticks and makePerf's overlay).
  const showPerf = !!gpu && has("perf") && options.get("perf") && (!!P || asked() === 0);
  if (showPerf && !readout) {
    readout = document.createElement("div");
    readout.className = "pace";
    (document.querySelector("#hud .panel") ?? document.body).append(readout);
  }
  let shown = 0, fps = 0, count = 0, countAt = 0;
  const report = (): PaceReport => {
    const now = renderer.getQuality();
    const upscaling = now.temporal && now.upscale < 1 && (now.shadowSteps > 0 || now.ao) && debug() === 0;
    const traced = moving && adaptive ? pacer.value() : upscaling ? now.upscale : 1;
    return { phone: !!P, adaptive, mode: moving ? "scale" : "upscale", traced, changes: pacer.changes(), fps, gpuMs: gpuMs(), output: [gpu?.width ?? 0, gpu?.height ?? 0], quality: now };
  };
  if (gpu && (P || asked() === 0)) (window as { renderPace?: () => PaceReport }).renderPace = report;

  const pace = (now: number, own: number): number => {
    const fixed = fixedScale();
    if (!gpu || (!P && !adaptive)) return fixed || own;
    // While the fraction adapts the render scale is not the page's: two controllers on one frame
    // time would chase each other.
    let out = fixed || (P ? (adaptive ? P.outputScale : Math.min(own, P.outputScale)) : own);
    if (adaptive) {
      const f = pacer.frame(now);
      if (moving) out *= f;
      else if (f !== q.upscale) {
        q = { ...q, upscale: f };
        renderer.setQuality({ upscale: f });
        setup.changed?.();
      }
    }
    count++;
    if (now - countAt >= 1000) { fps = (count * 1000) / (now - countAt); count = 0; countAt = now; }
    if (showPerf && readout && now - shown > 250) {
      shown = now;
      const r = report();
      const size = moving ? `${r.output[0]}×${r.output[1]}` : `${Math.ceil(r.output[0] * r.traced)}×${Math.ceil(r.output[1] * r.traced)}`;
      readout.textContent =
        `${fps.toFixed(0)} fps · ${moving && adaptive ? `scale ${out.toFixed(2)}, traced` : "traced"} ${r.traced.toFixed(2)}${adaptive ? "" : " fixed"} (${size})` +
        (r.gpuMs === null ? "" : ` · GPU ${r.gpuMs.toFixed(1)} ms`) + (slow > 1 ? ` ×${slow}` : "");
    }
    return out;
  };
  return { preset, fixedScale, adaptive: () => adaptive, pace };
}
