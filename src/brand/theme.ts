// GENERATED from voxolith/branding/web/theme.ts — do not edit here; run `bun scripts/sync.ts` in branding.
// Voxolith theme switch. Source of truth: voxolith/branding/web/theme.ts.
//
// Themes are CSS tokens in tokens.css. Without a stored choice the page
// follows prefers-color-scheme; a stored choice pins html[data-theme].
// index.html should also apply the stored value inline before first paint:
//   <script>try{var t=localStorage.getItem("voxolith-theme");if(t)document.documentElement.dataset.theme=t}catch(e){}</script>

export type Theme = "dark" | "light";

const KEY = "voxolith-theme";

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "dark" || v === "light" ? v : null;
  } catch {
    return null;
  }
}

/** The theme in effect: html[data-theme] (query override or stored choice), else the OS preference. */
export function currentTheme(): Theme {
  const forced = document.documentElement.dataset.theme;
  if (forced === "dark" || forced === "light") return forced;
  const s = stored();
  if (s) return s;
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function setTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* private mode etc. */
  }
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}

/**
 * Apply the stored theme (or a one-off `?theme=light|dark` query override,
 * which is not persisted) and wire a toggle button if given. Returns the
 * active theme.
 */
export function initTheme(toggle?: HTMLElement | null): Theme {
  const q = new URLSearchParams(location.search).get("theme");
  if (q === "dark" || q === "light") document.documentElement.dataset.theme = q;
  else {
    const s = stored();
    if (s) document.documentElement.dataset.theme = s;
  }
  const label = () => {
    if (!toggle) return;
    const t = currentTheme();
    toggle.textContent = t === "dark" ? "☀" : "☾";
    toggle.title = t === "dark" ? "Switch to light theme" : "Switch to dark theme";
    toggle.setAttribute("aria-label", toggle.title);
  };
  toggle?.addEventListener("click", () => {
    toggleTheme();
    label();
  });
  label();
  return currentTheme();
}
