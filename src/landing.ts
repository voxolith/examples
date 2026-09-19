// Landing page: styles, theme toggle, and swap the lockup when the theme is
// forced (the <picture> media query only follows the OS preference).
import "./shared/styles.css";
import { initTheme, currentTheme } from "./brand/theme";

const toggle = document.getElementById("theme-toggle");
const img = document.querySelector<HTMLImageElement>(".lockup img");
const src = document.querySelector<HTMLSourceElement>(".lockup source");
const base = import.meta.env.BASE_URL;
const sync = () => {
  const dark = currentTheme() === "dark";
  if (src) src.media = dark ? "all" : "not all";
  if (img) img.src = `${base}brand/${dark ? "lockup-dark.svg" : "lockup.svg"}`;
};
initTheme(toggle);
toggle?.addEventListener("click", sync);
sync();
