// minecraft-region: drop a Minecraft Anvil region file (.mca) onto the page,
// crop it into a voxel grid with buildMinecraftRegion, and fly through it with
// a first-person camera. No region file is bundled; grab one from any world's
// `region/` folder.

import { createRenderer, OccupancyGrid, buildMinecraftRegion, firstPersonFrame, resizeToDisplay, type Renderer } from "@voxolith/renderer";
import { axis, button, createInput, makeActions, makeLookController, makeTouchControls, prepareSurface } from "@voxolith/engine/input";
import { boot, runLoop } from "../shared/boot";
import { DAYLIGHT } from "../shared/env";

const app = await boot("minecraft-region");
if (app) {
  const { gpu, canvas, info } = app;
  let renderer: Renderer | null = null;

  // Free-fly controls, by action rather than by key, so the same loop works on
  // a keyboard, a gamepad and a phone. Keys are physical (`code`), so WASD
  // stays put on AZERTY.
  prepareSurface(canvas);
  const input = createInput(canvas);
  const actions = makeActions(input, {
    strafe: axis({ negative: ["key:KeyA", "key:ArrowLeft"], positive: ["key:KeyD", "key:ArrowRight"], analog: ["pad:LeftX", "touch:move.x"] }),
    walk: axis({ negative: ["key:KeyS", "key:ArrowDown"], positive: ["key:KeyW", "key:ArrowUp"], analog: ["pad:LeftY-", "touch:move.y-"] }),
    rise: axis({ negative: ["key:KeyC", "pad:LB", "touch:down"], positive: ["key:Space", "pad:RB", "touch:up"] }),
    fast: button("key:ShiftLeft", "key:ShiftRight", "pad:LT"),
  });
  // Click to capture the mouse (Esc releases), or drag; right stick; Q/E and R/F turn too.
  const look = makeLookController(input, {
    pitch: -10,
    keys: { left: ["KeyQ"], right: ["KeyE"], up: ["KeyR"], down: ["KeyF"] },
  });
  makeTouchControls(input, {
    joysticks: [{ id: "move", side: "left" }],
    buttons: [{ id: "up", label: "▲" }, { id: "down", label: "▼" }],
  });
  const eye: [number, number, number] = [0, 0, 0];

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
      look.set(0, -15);
      info.textContent = `${name} · ${scene.meta.chunks} chunks · ${scene.meta.voxels.toLocaleString()} voxels · click to look, WASD move, Space/C up/down, Shift fast`;
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
    input.update();
    look.update(dt);
    const speed = (actions.down("fast") ? 120 : 40) * dt;
    const y = (look.yaw() * Math.PI) / 180;
    // firstPersonFrame's basis: forward (sin, cos), screen-right cross(forward, up).
    const fwd = [Math.sin(y), Math.cos(y)], right = [-Math.cos(y), Math.sin(y)];
    // The joystick's y is down-positive; walk reads it inverted (touch:move.y-).
    const [sx, wz] = actions.vector("strafe", "walk");
    eye[0] += (fwd[0] * wz + right[0] * sx) * speed;
    eye[2] += (fwd[1] * wz + right[1] * sx) * speed;
    eye[1] += actions.value("rise") * speed;

    resizeToDisplay(gpu);
    renderer?.render({ ...firstPersonFrame(eye, look.yaw(), look.pitch(), 75), ...DAYLIGHT });
  });
}
