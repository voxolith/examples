// Lighting and sky values shared by the examples. FrameParams needs all of
// these on every frame; spread them after the camera fields.

import type { Vec3 } from "@voxolith/render";

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

const SUN = norm([0.5, 0.85, 0.35]);

/** Neutral daylight with a soft sky gradient. */
export const DAYLIGHT = {
  lightDir: SUN,
  lightColor: [1.0, 0.98, 0.94] as Vec3,
  ambientSky: [0.5, 0.53, 0.6] as Vec3,
  ambientGround: [0.3, 0.29, 0.27] as Vec3,
  sunDir: SUN,
  moonDir: [0, -1, 0] as Vec3,
  sunColor: [1, 0.96, 0.85] as Vec3,
  moonColor: [0, 0, 0] as Vec3,
  skyTop: [0.35, 0.55, 0.9] as Vec3,
  skyHorizon: [0.75, 0.82, 0.92] as Vec3,
  nightFactor: 0,
  sunIntensity: 1,
  moonIntensity: 0,
};

/** Dark studio backdrop, no visible sun disc. */
export const STUDIO = {
  ...DAYLIGHT,
  skyTop: [0.15, 0.16, 0.19] as Vec3,
  skyHorizon: [0.27, 0.29, 0.33] as Vec3,
  sunIntensity: 0,
};
