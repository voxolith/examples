// minecraft-region: drop a Minecraft Anvil region file (.mca) onto the page,
// crop it into a voxel grid with buildMinecraftRegion, and fly through it with
// a first-person camera. No region file is bundled; grab one from any world's
// `region/` folder.

import { createRenderer, OccupancyGrid, buildMinecraftRegion, firstPersonFrame, resizeToDisplay, type Renderer } from "@voxolith/renderer";
import { boot, runLoop } from "../shared/boot";
import { DAYLIGHT } from "../shared/env";

const app = await boot("minecraft-region");
if (app) {
  const { gpu, info } = app;
  let renderer: Renderer | null = null;

  // Camera state.
  const eye: [number, number, number] = [0, 0, 0];
  let yaw = 0, pitch = -10;
  const keys = new Set<string>();
  window.addEventListener("keydown", (e) => keys.add(e.key.toLowerCase()));
  window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));

  async function load(buf: ArrayBuffer, name: string) {
    info.textContent = `${name}: building…`;
    try {
      // A 256×256 block crop from the middle of the region, every 2nd block.
      const scene = await buildMinecraftRegion(new Uint8Array(buf), {
        x0: 128, x1: 383, z0: 128, z1: 383, downsample: 2,
      });
      const r = await createRenderer(gpu, {
        size: scene.size, data: scene.data, palette: scene.palette, materials: scene.materials,
      });
      r.updateCoarse(new OccupancyGrid(scene.size, scene.data).data);
      renderer = r;
      eye[0] = scene.size.x / 2; eye[1] = scene.size.y * 0.8; eye[2] = -10;
      yaw = 0; pitch = -15;
      info.textContent = `${name} · ${scene.meta.chunks} chunks · ${scene.meta.voxels.toLocaleString()} voxels · WASD move, Q/E turn, R/F pitch`;
    } catch (e) {
      info.textContent = `${name}: ${(e as Error).message}`;
    }
  }

  const root = document.body;
  document.addEventListener("dragover", (e) => { e.preventDefault(); root.classList.add("drop"); });
  document.addEventListener("dragleave", (e) => { if (e.relatedTarget === null) root.classList.remove("drop"); });
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    root.classList.remove("drop");
    const f = e.dataTransfer?.files?.[0];
    if (f) f.arrayBuffer().then((b) => load(b, f.name));
  });

  runLoop((_now, dt) => {
    // Free-fly controls: WASD strafe/forward, Q/E yaw, R/F pitch, Shift = fast.
    const speed = (keys.has("shift") ? 120 : 40) * dt;
    const y = (yaw * Math.PI) / 180;
    const fwd = [Math.sin(y), 0, Math.cos(y)], right = [Math.cos(y), 0, -Math.sin(y)];
    const move = (v: number[], s: number) => { eye[0] += v[0] * s; eye[2] += v[2] * s; };
    if (keys.has("w") || keys.has("arrowup")) move(fwd, speed);
    if (keys.has("s") || keys.has("arrowdown")) move(fwd, -speed);
    if (keys.has("d") || keys.has("arrowright")) move(right, speed);
    if (keys.has("a") || keys.has("arrowleft")) move(right, -speed);
    if (keys.has(" ")) eye[1] += speed;
    if (keys.has("c")) eye[1] -= speed;
    if (keys.has("q")) yaw -= 90 * dt;
    if (keys.has("e")) yaw += 90 * dt;
    if (keys.has("r")) pitch = Math.min(85, pitch + 60 * dt);
    if (keys.has("f")) pitch = Math.max(-85, pitch - 60 * dt);

    resizeToDisplay(gpu);
    renderer?.render({ ...firstPersonFrame(eye, yaw, pitch, 75), ...DAYLIGHT });
  });
}
