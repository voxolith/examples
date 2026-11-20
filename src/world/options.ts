// The URL options the world and valley pages share (../shared/options.ts): season, time of day
// and weather. Each page spreads them into its own declaration.

import { ATMOSPHERES, type AtmosphereName } from "@voxolith/engine/atmosphere";
import type { OptionSpec } from "../shared/options";

const title = (name: string) => name[0].toUpperCase() + name.slice(1);

/** `?season=`, `?time=night` and `?weather=`, as both valley pages take them. */
export const VALLEY_OPTIONS = {
  season: { kind: "choice", label: "Season", help: "The vegetation's season: leaves, blossom, bare wood.", values: ["spring", "summer", "autumn", "winter"], default: "summer", format: title },
  time: { kind: "choice", label: "Time of day", help: "Day or night (N, or the HUD's button). Opening at night starts by the lamp.", values: ["day", "night"], default: "day", live: true, format: title },
  weather: { kind: "choice", label: "Weather", help: "The engine's atmosphere preset (W cycles the HUD's list).", values: Object.keys(ATMOSPHERES) as AtmosphereName[], default: "clear", live: true, format: title },
} as const satisfies Record<string, OptionSpec>;
