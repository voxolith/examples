// The URL options the world and valley pages share (../shared/options.ts): season, time of day
// weather and which sky. Each page spreads them into its own declaration.

import { ATMOSPHERES, type AtmosphereName } from "@voxolith/engine/atmosphere";
import type { OptionSpec } from "../shared/options";

const title = (name: string) => name[0].toUpperCase() + name.slice(1);

/** `?season=`, `?time=night`, `?weather=` and `?sky=`, as both valley pages take them. */
export const VALLEY_OPTIONS = {
  season: { kind: "choice", label: "Season", help: "The vegetation's season: leaves, blossom, bare wood.", values: ["spring", "summer", "autumn", "winter"], default: "summer", format: title },
  time: { kind: "choice", label: "Time of day", help: "Day or night (N, or the HUD's button). Opening at night starts by the lamp.", values: ["day", "night"], default: "day", live: true, format: title },
  weather: { kind: "choice", label: "Weather", help: "The engine's atmosphere preset (W cycles the HUD's list).", values: Object.keys(ATMOSPHERES) as AtmosphereName[], default: "clear", live: true, format: title },
  sky: { kind: "choice", label: "Sky", help: "Classic: the engine's stylised sky. Physical: scattering from look-up tables (after Hillaire 2020), which also gives the sun's, moon's and sky's light.", values: ["classic", "physical"], default: "classic", format: title },
} as const satisfies Record<string, OptionSpec>;
