// rigged — the same rats baked and posed on the GPU, side by side.
//
// In each pair, left (on green): every pose baked into voxels on the CPU (bakePose) and drawn as an
// instance of that posed model. Right (on blue): one rest model per rat, drawn as a single instance
// carrying its bone matrices; the
// renderer takes each world cell back through every bone's inverse into the rest model (the
// engine's makeCrowd `rigged` option). Each pair plays the same clip, so seams at the joints can
// be compared directly. The baked side also closes diagonal gaps and cracks; the GPU side welds
// joints only.
//
// ?vpm=100 uses rats sized for a 100 voxels-per-metre world (smaller, finer); ?yaw= turns them;
// ?pairs= shows only the first few clips; ?distance= sets the camera distance.
//
// Posing on the GPU from a shared rest model follows Gruen, Benthin, Kern and McAllister, "Ray
// Tracing Massive Amounts of Animated Geometry" (HPG 2026, doi:10.1145/3820014), and Kao,
// Makowski, Fujieda and Harada, "Voxel Deformation-Aware Neural Intersection Function" (EG 2026,
// doi:10.2312/egs.20261026).

import { createRenderer, makeCamera, observeResize, resizeToDisplay, type Renderer } from "@voxolith/renderer";
import { seededRandom } from "@voxolith/renderer/core";
import { makeInstanceLayer, PaletteAllocator, type InstanceLayer, type InstancePlacement } from "@voxolith/engine";
import { makeAnimator, makeCrowd, type CrowdMember } from "@voxolith/engine/animation";
import { createInput, makeOrbitController, prepareSurface } from "@voxolith/engine/input";
import { atmosphereFrame, ATMOSPHERES, timeOfDay } from "@voxolith/engine/atmosphere";
import { atScale, generateCreature, PRESETS } from "@voxolith/gen-creature";
import { boot, runLoop } from "../shared/boot";

const params = new URLSearchParams(location.search);
const vpm = Number(params.get("vpm") ?? 10);
const yaw = Number(params.get("yaw") ?? 0.35);
const distance = Number(params.get("distance") ?? 230);
const PAIR = 64, GAP = 30;
const SIZE = { x: 480, y: 48, z: 150 };

const app = await boot("rigged");
if (app) {
  const { gpu, canvas, info } = app;
  const rat = generateCreature(vpm > 10 ? atScale(PRESETS.rat, vpm) : PRESETS.rat, seededRandom(11), "rat").entity;
  const clips = rat.clips!.map((c) => c.id).slice(0, Math.max(1, Number(params.get("pairs") ?? 99)));

  // Ground in two tones: under the baked rat of each pair, and under the one posed on the GPU.
  const palette = new PaletteAllocator(1);
  const { base: groundBase } = palette.allocate(
    [
      { id: "left", name: "left", color: [0.36, 0.45, 0.3] },
      { id: "right", name: "right", color: [0.3, 0.4, 0.46] },
    ],
    "ground",
  );
  const ratBase = palette.allocate(rat.model.roles, "rat").base;
  const renderer: Renderer = await createRenderer(gpu, { size: SIZE, palette: palette.buildPalette(), materials: palette.buildMaterials() });
  renderer.setClipBounds([0, 0, 0], [SIZE.x - 1, SIZE.y - 1, SIZE.z - 1]);
  renderer.setQuality(gpu.software ? "low" : "high");
  renderer.edit({ x0: 0, y0: 0, z0: 0, x1: SIZE.x - 1, y1: 3, z1: SIZE.z - 1 }, (cells, ox, oy) => {
    for (let z = 0; z < 8; z++) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++)
      if (oy + y <= 3) cells[x + y * 8 + z * 64] = groundBase + (((ox + x) % PAIR) < GAP ? 0 : 1);
    return true;
  });

  // One layer, two crowds: each collects its placements and the page commits both together.
  const layer = makeInstanceLayer(renderer);
  const collect = (): InstanceLayer & { list: readonly InstancePlacement[] } => {
    const c = { ...layer, list: [] as readonly InstancePlacement[], setDynamic(l: readonly InstancePlacement[]) { c.list = l; }, commit() {} };
    return c;
  };
  const leftLayer = collect(), rightLayer = collect();
  const baked = makeCrowd({ instances: leftLayer, near: 1e9, freeze: 1e9 });
  const posed = makeCrowd({ instances: rightLayer, rigged: true, near: 1e9, freeze: 1e9 });

  // One pair per clip along x: baked on the left, posed on the GPU on the right.
  const member = (id: number, side: number, i: number): CrowdMember => ({
    id, entity: rat, variant: "rat", anim: makeAnimator(rat, clips[i]), base: ratBase,
    x: i * PAIR + (side ? GAP + (PAIR - GAP) / 2 : GAP / 2), y: 4, z: SIZE.z / 2, yaw,
  });
  const left = clips.map((_, i) => member(i + 1, 0, i));
  const right = clips.map((_, i) => member(i + 101, 1, i));

  const target: [number, number, number] = [(clips.length * PAIR) / 2, 6, SIZE.z / 2];
  const camera = makeCamera({ target, distance, pitchDeg: 38, fovDeg: 40 });
  prepareSurface(canvas, { contextMenu: false });
  const input = createInput(canvas, { loop: { invalidate: () => loop.invalidate() } });
  const orbit = makeOrbitController(input, { yaw: 0, pitch: 38, distance, distanceLimits: [20, 600], pitchLimits: [5, 85], fovDeg: 40, target, pan: "secondary" });
  const sky = atmosphereFrame(timeOfDay(0.42), ATMOSPHERES.clear);
  info.textContent = `each pair: baked on the CPU (left, green) · posed on the GPU (right, blue) · ${clips.join(", ")}`;

  let last = performance.now();
  const loop = runLoop((now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    for (const m of [...left, ...right]) m.anim.update(dt);
    const f = camera(orbit.yaw(), orbit.distance(), orbit.target(), orbit.pitch());
    const cam = f.camPos as [number, number, number];
    baked.update(left, cam);
    posed.update(right, cam);
    layer.setDynamic([...leftLayer.list, ...rightLayer.list]);
    layer.commit();
    resizeToDisplay(gpu);
    renderer.render({ ...f, ...sky, time: now / 1000 });
  }, true);
  observeResize(canvas, loop);
}
