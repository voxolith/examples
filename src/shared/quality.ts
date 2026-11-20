// The renderer's quality, from a page's options: one place that reads RENDER_OPTIONS
// (./options.ts), sets `renderer.setQuality` and applies the panel's changes live, so every page
// offers the same knobs the same way. The page says only what is its own: the preset this device
// starts on and the step caps its scene needs.

import { QUALITY_PRESETS, type QualityPreset, type RenderQuality, type Renderer } from "@voxolith/renderer";
import type { PageOptions, RENDER_OPTIONS } from "./options";
import { prepared } from "./loading";

/** What a page gives {@link applyRenderOptions}. */
export interface RenderSetup {
  /** The preset on this device when the URL names none (Low on a CPU adapter, as every page does). */
  preset: QualityPreset;
  /** The page's own changes to a preset: step caps for its scene's size. */
  tweak?: (preset: QualityPreset) => Partial<RenderQuality>;
  /** The page's defaults where they differ from the presets' (temporal off, reflections on, upscale 1). */
  temporal?: boolean;
  reflections?: boolean;
  upscale?: number;
  /** Called after a live change, to redraw (and restart whatever the page measures). */
  changed?: () => void;
}

/** What the page reads back. */
export interface RenderControls {
  /** The preset in use. */
  preset(): QualityPreset;
  /** The fixed render scale asked for, or 0 for the page's own (adaptive) one. */
  fixedScale(): number;
}

type Keys = keyof typeof RENDER_OPTIONS;
/** A page's options that include the shared render options (all of them, or all but those in `omit`). */
type RenderPageOptions<O extends Keys> = PageOptions<Omit<typeof RENDER_OPTIONS, O>>;

/**
 * Set the renderer's quality from the page's options and keep it in step with the panel. Call it
 * before `renderer.prepare()`, which compiles the pipelines the quality needs. `omit` names shared
 * options the page did not declare (instances has an `?upscale=` of its own).
 *
 * @example
 * ```ts
 * const render = applyRenderOptions(options, renderer, { preset: gpu.software ? "low" : "medium", changed: () => loop.invalidate() });
 * // per frame:
 * gpu.renderScale = render.fixedScale() || perf.scale();
 * ```
 */
export function applyRenderOptions<O extends Keys = never>(page: RenderPageOptions<O>, renderer: Renderer, setup: RenderSetup, omit: readonly O[] = []): RenderControls {
  const options = page as unknown as PageOptions<typeof RENDER_OPTIONS>;
  const has = (key: Keys) => !(omit as readonly Keys[]).includes(key);
  const preset = () => options.get("quality", setup.preset);
  const quality = (): RenderQuality => {
    const p = preset();
    return {
      ...QUALITY_PRESETS[p],
      ...setup.tweak?.(p),
      temporal: has("temporal") ? options.get("temporal", setup.temporal ?? false) : (setup.temporal ?? false),
      reflections: has("reflections") ? options.get("reflections", setup.reflections ?? true) : (setup.reflections ?? true),
      upscale: has("upscale") ? options.get("upscale", setup.upscale ?? 1) : (setup.upscale ?? 1),
    };
  };
  renderer.setQuality(quality());
  // A change of temporal or reflections needs pipelines of its own: compile them first, so the
  // frame that switches does not stall on it.
  const apply = () => {
    const q = quality();
    void prepared(renderer.prepare({ temporal: q.temporal, reflections: q.reflections })).then(() => {
      renderer.setQuality(q);
      setup.changed?.();
    });
  };
  for (const key of ["quality", "temporal", "reflections", "upscale"] as const) if (has(key)) options.on(key, apply);
  if (has("renderScale")) options.on("renderScale", () => setup.changed?.());
  if (has("debug")) {
    if (options.get("debug")) renderer.setDebug(options.get("debug"));
    options.on("debug", (v) => { renderer.setDebug(v); setup.changed?.(); });
  }
  return { preset, fixedScale: () => (has("renderScale") ? options.get("renderScale") : 0) };
}
