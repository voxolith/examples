// A page's URL options, declared once: the same declaration parses the query string and builds
// the options panel, so what the URL takes and what the page offers cannot drift apart.
//
// A page declares its options as data, next to where it reads them:
//
//   const options = defineOptions({
//     count: { kind: "number", label: "Rats", help: "How many rats roam the patch.", min: 1, max: 40, step: 1, integer: true, default: 8 },
//     perf: { kind: "toggle", label: "Performance overlay", help: "Frame times and the adaptive render scale.", default: false },
//     weather: { kind: "choice", label: "Weather", help: "The engine's atmosphere preset.", values: ["clear", "rain"], default: "clear", live: true },
//   });
//   const COUNT = options.get("count");
//   const app = await boot("creature", { steps, options });   // adds the HUD's Options button
//   options.on("weather", (name) => setWeather(name));         // how a live option applies
//
// The URL stays the source of truth, and stays shareable. An option marked `live` whose page has
// registered a handler (`on`) applies at once and rewrites the query string in place; every other
// option is staged in the panel and applied by its "Apply and reload" button, which loads the page
// with the new query. A value equal to its default is left out of the URL. Parameters the
// declaration does not know (and the hidden, developer-only ones) pass through untouched.
//
// Defaults that depend on the device (a phone's lighter profile, a CPU adapter) are given where
// the page reads the option, `options.get("vpm", phone ? 20 : 50)`: the panel then shows that
// effective value, and leaves it out of the URL like any default.
//
// The panel is plain DOM beside the canvas: a popover under the HUD on a desktop, a bottom sheet
// with touch-sized controls on a narrow or touch screen. It closes on Escape, on its button and on
// a press outside it (which still reaches the scene, so the page stays usable behind it). The
// engine's input layer owns the canvas and listens for keys on the window; pointer events in the
// panel never reach the canvas (it is not an ancestor), and the panel stops its key events from
// bubbling, so typing in it moves no camera. No `visibility` in its CSS: the test tools hide the
// HUD with it, the panel included.

/** What every option declares. */
interface OptionCommon {
  /** The control's label. */
  label: string;
  /** One line under the label saying what the option does. */
  help: string;
  /**
   * Applies without a reload, once the page has said how (`PageOptions.on`). Without it, or
   * until then, a change is staged and applied by reloading with the new query.
   */
  live?: boolean;
  /** Parsed through the declaration but not shown: a switch for developers and tools. */
  hidden?: boolean;
}

/** On or off. In the URL: `?key` or `?key=1` is on, `?key=0` off. */
export interface ToggleOption extends OptionCommon {
  kind: "toggle";
  default: boolean;
}

/** One of a list. */
export interface ChoiceOption extends OptionCommon {
  kind: "choice";
  values: readonly (string | number)[];
  default: string | number;
  /** A numeric value not in the list snaps to the nearest one instead of falling back to the default. */
  snap?: boolean;
  /** The text shown for a value (default: the value). */
  format?: (value: never) => string;
}

/** A number in a range, stepped by the panel's buttons. A URL value is clamped, not snapped to the step. */
export interface NumberOption extends OptionCommon {
  kind: "number";
  min: number;
  max: number;
  step: number;
  default: number;
  /** Round a URL value to a whole number. */
  integer?: boolean;
}

/** Free text (a seed). */
export interface TextOption extends OptionCommon {
  kind: "text";
  default: string;
}

/** One declared option. */
export type OptionSpec = ToggleOption | ChoiceOption | NumberOption | TextOption;

/** The value type of an option: boolean, the union of a choice's values, number or string. */
export type OptionValue<S> = S extends { kind: "toggle" }
  ? boolean
  : S extends { kind: "choice"; values: readonly (infer V)[] }
    ? V
    : S extends { kind: "number" }
      ? number
      : string;

type Value = string | number | boolean;

/** A page's options: read them, apply the live ones, and (through `boot`) show the panel. */
export interface PageOptions<S extends Record<string, OptionSpec> = Record<string, OptionSpec>> {
  /**
   * The option's value: from the URL, else `fallback` (the default on this device), else the
   * declared default. A given `fallback` is remembered as the effective default the panel shows
   * and the URL omits.
   */
  get<K extends keyof S & string>(key: K, fallback?: OptionValue<S[K]>): OptionValue<S[K]>;
  /** Whether the URL the page loaded with gave this option. */
  given(key: keyof S & string): boolean;
  /** How a live option applies when the panel changes it. */
  on<K extends keyof S & string>(key: K, apply: (value: OptionValue<S[K]>) => void): void;
  /**
   * Tell the options of a change the page made itself (a HUD button, a key): the URL and the
   * panel follow; the `on` handler is not called.
   */
  sync<K extends keyof S & string>(key: K, value: OptionValue<S[K]>): void;
  /** Leave an option out of the panel on this device (`?full` where there is no phone profile). */
  hide(key: keyof S & string): void;
  /** Add the Options button and its panel to the HUD. `boot` calls it; nothing is added when no option shows. */
  mount(): void;
}

const OFF = new Set(["0", "false", "off", "no"]);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** Clear of the float error stepping leaves (0.1 + 0.2). */
const tidy = (v: number) => +v.toFixed(6);

function parse(spec: OptionSpec, raw: string | null, fallback: Value): Value {
  if (raw === null) return fallback;
  if (spec.kind === "toggle") return !OFF.has(raw.toLowerCase());
  if (spec.kind === "text") return raw;
  if (spec.kind === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return clamp(spec.integer ? Math.round(n) : n, spec.min, spec.max);
  }
  const hit = spec.values.find((v) => String(v) === raw);
  if (hit !== undefined) return hit;
  const n = Number(raw);
  if (spec.snap && Number.isFinite(n)) {
    const nums = spec.values.filter((v): v is number => typeof v === "number");
    if (nums.length) return nums.reduce((best, v) => (Math.abs(v - n) < Math.abs(best - n) ? v : best));
  }
  return fallback;
}

const write = (v: Value) => (typeof v === "boolean" ? (v ? "1" : "0") : typeof v === "number" ? String(tidy(v)) : v);
/** `a=1&e2e=` reads better, and round-trips, as `a=1&e2e`. */
const queryOf = (p: URLSearchParams) => p.toString().replace(/=(?=&|$)/g, "");

/** Options several pages share, to spread into a declaration. */
export const OPTION = {
  /** `?perf`: makePerf's overlay. A reload: the overlay is made with the controller. */
  perf: { kind: "toggle", label: "Performance overlay", help: "Frame time, GPU time and the adaptive render scale; the load timeline goes to the console.", default: false },
  /** `?full`: the desktop profile on a phone. Pages hide it where the device gets no phone profile. */
  full: { kind: "toggle", label: "Desktop settings", help: "Skip the lighter phone profile on this device.", default: false },
  /**
   * `?phone`: the phone profile on any device, to look at it on a desktop (the GPU stays the
   * desktop's, so it says nothing about a phone's frame rate). `?phone=45` also makes the traced
   * fraction's controller read every GPU time 45 times longer, so it settles where a GPU that
   * much slower would: the picture such a phone would get, not its frame rate. Hidden; `?full`
   * still wins, and `?phone=0` is off.
   */
  phone: { kind: "text", label: "Phone profile", help: "Apply the phone profile on this device; a number also slows the GPU time its controller reads by that factor.", default: "", hidden: true },
  /** `?e2e`: the page's window hooks for the test tools. Hidden. */
  e2e: { kind: "toggle", label: "Test hooks", help: "Expose the page's window hooks for the test tools.", default: false, hidden: true },
  /** `?selftest=`: the renderer's voxel-lookup self-test bands (setDebug 7 to 9). Hidden. */
  selftest: { kind: "text", label: "Lookup self-test", help: "Bands showing which stage of the voxel lookup works on this GPU (1, 2 or 3).", default: "", hidden: true },
} as const satisfies Record<string, OptionSpec>;

/**
 * The renderer's cost and quality knobs, under the same names and help on every page that offers
 * them: spread into the page's declaration and hand the options to `applyRenderOptions`
 * (./quality.ts), which reads them, sets the renderer's quality and applies changes live. A page
 * with a fixed render scale (bench, temporal) spreads `renderScale` with its own range. With them
 * come the three switches of the phone profile (./scale.ts `phoneProfile`): `perf`, `full` and
 * the hidden `phone`.
 */
export const RENDER_OPTIONS = {
  /** `?quality=low|medium|high`: `QUALITY_PRESETS`; the page gives the device's default. */
  quality: { kind: "choice", label: "Quality", help: "The renderer's preset: low has no shadows or ambient occlusion, high traces the longest rays.", values: ["low", "medium", "high"], default: "medium", live: true, format: (v: string) => v[0].toUpperCase() + v.slice(1) },
  /** `?temporal=1`: `RenderQuality.temporal`. */
  temporal: { kind: "toggle", label: "Temporal accumulation", help: "Keep shadows and ambient occlusion per pixel across frames and trace them only until they have converged; shadows turn soft. Nothing to accumulate on the low preset.", default: false, live: true },
  /** `?upscale=0.5`: `RenderQuality.upscale`. */
  upscale: { kind: "number", label: "Traced fraction", help: "With temporal accumulation on: trace at this fraction of the output size and resolve to it over frames. 0 adapts it to the frame time, which is a phone's default.", min: 0, max: 1, step: 0.25, default: 1, live: true },
  /** `?reflections=0`: `RenderQuality.reflections`. */
  reflections: { kind: "toggle", label: "Reflections", help: "Water, metal and glass trace their secondary rays. Off compiles them out, which makes every pixel cheaper.", default: true, live: true },
  /** `?renderScale=0.5`: a fixed `gpu.renderScale`; 0 leaves it to the page (adaptive where it has `makePerf`). */
  renderScale: { kind: "number", label: "Render scale", help: "A fixed fraction of the canvas to render; 0 lets the page pick, and adapt it to the frame time where it does.", min: 0, max: 2, step: 0.1, default: 0, live: true },
  /** `?debug=10|1`: `Renderer.setDebug`. */
  debug: { kind: "choice", label: "Debug view", help: "The renderer's own views: how many steps each primary ray took (blue few, red the cap), or the walk without empty-space skipping.", values: [0, 10, 1], default: 0, live: true, format: (v: number) => (v === 10 ? "Step heatmap" : v === 1 ? "No skipping" : "Off") },
  /** `?perf`: the frame rate, and on a phone the traced fraction (./quality.ts); makePerf's overlay where the page has one. */
  perf: OPTION.perf,
  /** `?full`: the desktop settings on a phone (./scale.ts `phoneProfile` hides it elsewhere). */
  full: OPTION.full,
  /** `?phone`: the phone profile on a desktop. Hidden. */
  phone: OPTION.phone,
} as const satisfies Record<string, OptionSpec>;

/** `?seed=`: the text every random choice on the page derives from. */
export const seedOption = (name: string) =>
  ({ kind: "text", label: "Seed", help: "Any text; the same seed builds the same scene.", default: name }) as const satisfies TextOption;

let ids = 0;

/**
 * Declare a page's options and read the URL through them.
 *
 * @example
 * ```ts
 * const options = defineOptions({
 *   count: { kind: "number", label: "Rats", help: "How many rats.", min: 1, max: 40, step: 1, integer: true, default: 8 },
 * });
 * const COUNT = options.get("count");
 * ```
 */
export function defineOptions<const S extends Record<string, OptionSpec>>(specs: S): PageOptions<S> {
  const url = new URLSearchParams(location.search);
  interface State { spec: OptionSpec; raw: string | null; fallback: Value; value?: Value; apply?: (v: never) => void; hidden: boolean; refresh?: () => void }
  const states = new Map<string, State>();
  for (const [key, spec] of Object.entries(specs)) states.set(key, { spec, raw: url.get(key), fallback: spec.default, hidden: !!spec.hidden });
  const st = (key: string) => states.get(key)!;
  const current = (s: State): Value => (s.value !== undefined ? s.value : parse(s.spec, s.raw, s.fallback));

  /** Changes staged in the panel, applied by a reload. */
  const pending = new Map<string, Value>();
  let foot: (() => void) | null = null;

  const setParam = (p: URLSearchParams, key: string, v: Value) => {
    if (v === st(key).fallback) p.delete(key);
    else p.set(key, write(v));
  };
  const replaceUrl = (key: string, v: Value) => {
    const p = new URLSearchParams(location.search);
    setParam(p, key, v);
    const q = queryOf(p);
    history.replaceState(history.state, "", location.pathname + (q ? `?${q}` : "") + location.hash);
  };
  /** A change from the panel: at once when the option is live and the page listens, else staged. */
  const change = (key: string, v: Value) => {
    const s = st(key);
    if (s.spec.live && s.apply) {
      s.value = v;
      replaceUrl(key, v);
      (s.apply as (v: Value) => void)(v);
    } else if (v === current(s)) pending.delete(key);
    else pending.set(key, v);
    s.refresh?.();
    foot?.();
  };
  const reload = (edit: (p: URLSearchParams) => void) => {
    const p = new URLSearchParams(location.search);
    edit(p);
    location.search = queryOf(p);
  };

  let mounted = false;
  const mount = () => {
    const hud = document.getElementById("hud");
    const bar = hud?.querySelector(".panel");
    /** The options in the panel; read when it first opens, so a page's `hide` and device defaults are in. */
    const visible = () => [...states].filter(([, s]) => !s.hidden);
    if (mounted || !hud || !bar || !visible().length) return;
    mounted = true;
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text) e.textContent = text;
      return e;
    };
    const button = el("button", "options-toggle", "Options");
    button.type = "button";
    button.title = "This page's options";
    button.setAttribute("aria-expanded", "false");
    const panel = el("div", "options");
    panel.id = "options-panel";
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Options");
    button.setAttribute("aria-controls", panel.id);
    const head = el("div", "options-head");
    const close = el("button", "options-close", "Close");
    close.type = "button";
    head.append(el("h2", "", "Options"), close);
    const list = el("div", "options-list");
    const footer = el("div", "options-foot");
    const reset = el("button", "options-reset", "Defaults");
    reset.type = "button";
    reset.title = "Reload with every option at its default";
    const apply = el("button", "options-apply", "Apply and reload");
    apply.type = "button";
    footer.append(reset, apply);
    panel.append(head, list, footer);

    let built = false;
    const build = () => {
      built = true;
      for (const [key, s] of visible()) row(key, s);
    };
    const row = (key: string, s: State) => {
      const spec = s.spec;
      const id = `option-${key}-${ids++}`;
      const line = el("div", "options-row");
      const text = el("div", "options-text");
      const label = el("label", "", spec.label);
      label.htmlFor = id;
      const tag = el("span", "options-tag");
      label.append(tag);
      const help = el("p", "", `${spec.help} `);
      help.id = `${id}-help`;
      help.append(el("code", "", `?${key}${spec.kind === "toggle" ? "" : "="}`));
      text.append(label, help);
      const control = el("div", "options-control");
      /** The value the row shows: the staged one, else the current one. */
      const showing = () => (pending.has(key) ? pending.get(key)! : current(s));
      let paint: () => void;
      if (spec.kind === "toggle") {
        const input = el("input");
        input.type = "checkbox";
        input.addEventListener("change", () => change(key, input.checked));
        paint = () => { input.checked = showing() as boolean; };
        input.id = id;
        input.setAttribute("aria-describedby", help.id);
        control.append(input);
      } else if (spec.kind === "choice") {
        const select = el("select");
        const format = (spec.format ?? String) as (v: string | number) => string;
        for (const v of spec.values) select.append(new Option(format(v), String(v)));
        select.addEventListener("change", () => change(key, spec.values.find((v) => String(v) === select.value) ?? spec.default));
        paint = () => { select.value = String(showing()); };
        select.id = id;
        select.setAttribute("aria-describedby", help.id);
        control.append(select);
      } else if (spec.kind === "number") {
        const input = el("input");
        input.type = "number";
        input.min = String(spec.min);
        input.max = String(spec.max);
        input.step = String(spec.step);
        input.inputMode = spec.integer || Number.isInteger(spec.step) ? "numeric" : "decimal";
        const set = (v: number) => change(key, tidy(clamp(spec.integer ? Math.round(v) : v, spec.min, spec.max)));
        const stepBy = (dir: number) => set(Math.round((showing() as number) / spec.step + dir) * spec.step);
        const less = el("button", "options-step", "−");
        const more = el("button", "options-step", "+");
        less.type = more.type = "button";
        less.setAttribute("aria-label", `Less: ${spec.label}`);
        more.setAttribute("aria-label", `More: ${spec.label}`);
        less.addEventListener("click", () => stepBy(-1));
        more.addEventListener("click", () => stepBy(1));
        input.addEventListener("change", () => (Number.isFinite(input.valueAsNumber) ? set(input.valueAsNumber) : paint()));
        paint = () => {
          const v = showing() as number;
          input.value = String(tidy(v));
          less.disabled = v <= spec.min;
          more.disabled = v >= spec.max;
        };
        input.id = id;
        input.setAttribute("aria-describedby", help.id);
        control.append(less, input, more);
      } else {
        const input = el("input");
        input.type = "text";
        input.spellcheck = false;
        input.autocapitalize = "off";
        input.addEventListener("change", () => change(key, input.value));
        paint = () => { input.value = String(showing()); };
        input.id = id;
        input.setAttribute("aria-describedby", help.id);
        control.append(input);
      }
      s.refresh = () => {
        paint();
        const live = !!(spec.live && s.apply);
        tag.textContent = pending.has(key) ? "changed" : live ? "" : "reloads";
        line.classList.toggle("pending", pending.has(key));
      };
      line.append(text, control);
      list.append(line);
    };
    foot = () => {
      apply.disabled = pending.size === 0;
      apply.textContent = pending.size > 1 ? `Apply ${pending.size} changes and reload` : "Apply and reload";
    };
    apply.addEventListener("click", () => reload((p) => { for (const [key, v] of pending) setParam(p, key, v); }));
    reset.addEventListener("click", () => reload((p) => { for (const [key] of visible()) p.delete(key); }));

    let open = false;
    const setOpen = (on: boolean, refocus = true) => {
      if (on === open) return;
      open = on;
      panel.hidden = !on;
      button.setAttribute("aria-expanded", String(on));
      if (on) {
        if (!built) build();
        for (const [, s] of states) s.refresh?.();
        foot?.();
        // On a desktop the popover hangs under the HUD's bar, however many lines that takes.
        panel.style.setProperty("--options-top", `${Math.round(bar.getBoundingClientRect().bottom - hud.getBoundingClientRect().top + 8)}px`);
        list.scrollTop = 0;
        close.focus({ preventScroll: true });
      } else if (refocus) button.focus({ preventScroll: true });
    };
    button.addEventListener("click", () => setOpen(!open));
    close.addEventListener("click", () => setOpen(false));
    // Keys in the panel stay in the panel: the input layer listens on the window.
    for (const type of ["keydown", "keyup", "keypress"] as const)
      panel.addEventListener(type, (e) => {
        if (type === "keydown" && e.key === "Escape") setOpen(false);
        e.stopPropagation();
      });
    document.addEventListener("keydown", (e) => { if (open && e.key === "Escape") setOpen(false); });
    // A press outside closes it and goes on to whatever it hit (the scene).
    document.addEventListener("pointerdown", (e) => {
      const t = e.target as Node | null;
      if (open && t && !panel.contains(t) && !button.contains(t)) setOpen(false, false);
    }, true);

    const theme = bar.querySelector("#theme-toggle");
    if (theme) theme.before(button, " ");
    else bar.append(" ", button);
    hud.append(panel);
  };

  return {
    get(key, fallback) {
      const s = st(key);
      if (fallback !== undefined) s.fallback = fallback as Value;
      return current(s) as never;
    },
    given: (key) => st(key).raw !== null,
    on(key, fn) {
      const s = st(key);
      s.apply = fn as (v: never) => void;
      // Staged before the page listened: it applies live after all.
      if (s.spec.live && pending.has(key)) {
        const v = pending.get(key)!;
        pending.delete(key);
        change(key, v);
      } else s.refresh?.();
    },
    sync(key, value) {
      const s = st(key);
      s.value = value as Value;
      pending.delete(key);
      replaceUrl(key, value as Value);
      s.refresh?.();
      foot?.();
    },
    hide(key) { st(key).hidden = true; },
    mount,
  };
}
