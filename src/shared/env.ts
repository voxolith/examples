// Lighting and sky values shared by the examples. Spread one after the camera fields of every
// `renderer.render` call; the renderer must be created with `background: classicSky`
// (`@voxolith/engine/atmosphere`), which draws the packed `background` below.

import { classicSkyParams, type ClassicSkyFrame } from "@voxolith/engine/atmosphere";
import type { Vec3 } from "@voxolith/renderer";

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

const SUN = norm([0.5, 0.85, 0.35]);

/** The daylight sky: a blue gradient with the sun disc, no moon, stars or clouds. */
const DAY_SKY: ClassicSkyFrame = {
  sunDir: SUN,
  moonDir: [0, -1, 0],
  sunColor: [1, 0.96, 0.85],
  moonColor: [0, 0, 0],
  skyTop: [0.35, 0.55, 0.9],
  skyHorizon: [0.75, 0.82, 0.92],
  nightFactor: 0,
  sunIntensity: 1,
  moonIntensity: 0,
};

/** Neutral daylight with a soft sky gradient. */
export const DAYLIGHT = {
  lightDir: SUN,
  lightColor: [1.0, 0.98, 0.94] as Vec3,
  ambientSky: [0.5, 0.53, 0.6] as Vec3,
  ambientGround: [0.3, 0.29, 0.27] as Vec3,
  // Packed once: the sky never changes, so every frame shares this array.
  background: classicSkyParams(DAY_SKY),
};

/** Dark studio backdrop, no visible sun disc. */
export const STUDIO = {
  ...DAYLIGHT,
  background: classicSkyParams({ ...DAY_SKY, skyTop: [0.15, 0.16, 0.19], skyHorizon: [0.27, 0.29, 0.33], sunIntensity: 0 }),
};
