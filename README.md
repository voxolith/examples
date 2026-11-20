<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/voxolith/.github/main/profile/lockup-dark.svg">
    <img alt="Voxolith — WebGPU voxel engine" src="https://raw.githubusercontent.com/voxolith/.github/main/profile/lockup.svg" width="420">
  </picture>
</p>

# Voxolith examples

Runnable pages for Voxolith, the WebGPU voxel raymarching engine:
[`@voxolith/renderer`](https://github.com/voxolith/renderer),
[`@voxolith/engine`](https://github.com/voxolith/engine) and the
[generators](https://github.com/voxolith/generators). Each example is one `main.ts` with comments,
on top of the shared plumbing in `src/shared/`; each has a page in the
[docs](https://voxolith.github.io/docs/examples/).

| example | shows | lines |
|---|---|---|
| [`hello-vox`](src/hello-vox/main.ts) | load a `.vox`, `parseVox`, `createRenderer`, `OccupancyGrid`, `makeCamera`, render loop | ~55 |
| [`orbit`](src/orbit/main.ts) | writing a procedural grid by hand, `createInput` + `makeOrbitController` (drag, wheel, pinch, right-drag pan), `setFloor` | ~75 |
| [`minecraft-region`](src/minecraft-region/main.ts) | drop a Minecraft `.mca`, `buildMinecraftRegion` crop and downsample, `firstPersonFrame` free-fly with `makeActions`, `makeLookController` (pointer lock) and a touch joystick | ~110 |
| [`world`](src/world/main.ts) | a whole valley from the generators: `gen-terrain` ground and a river with animated water, a village laid out on it (sites, levelled pads, footpaths) and a forest that fades into it, streamed with `makeChunkedWorld`; a draggable lamp (`setLights`), day/night (`timeOfDay`, `N`, `?time=night`) and weather (`@voxolith/engine/atmosphere`, `W`, `?weather=rain`) | ~520 |
| [`creature`](src/creature/main.ts) | rigged, animated rats from `gen-creature`: `makeAnimator`, `bakePose` through a pose cache, `makeBrickStamper`; tap to `wound`, tap again to `sever` (gibs, blood) | ~400 |
| [`valley`](src/valley/main.ts) | the world's valley at 50 voxels per metre (100 with `?vpm=100`) from the same layout (`world/layout.ts`): generators refined to 2 or 1 cm voxels (`{ voxelsPerMetre }`), every model drawn as instances (`makeInstanceLayer`, `orientationYaw`), `refineTerrain` ground with grass blades streamed in chunks, rats as an instanced crowd where they are real size (100 vox/m, `realSizeAt`); models cached in IndexedDB after the first visit; phones get a lighter profile at 20 vox/m (`?full` for the desktop one); `?vpm=`, `?variants=`, `?rats=`, `?radius=` | ~630 |
| [`instances`](src/instances/main.ts) | six tree models placed hundreds of times at any heading and a crowd of rats drawn by reference (`addModel`, `setInstances`, `makeCrowd({ instances })`); `?stamp` to compare with stamping | ~240 |
| [`swarm`](src/swarm/main.ts) | hundreds of animated rats with `makeCrowd` (pose cache, bake budget, distance LOD), scattering from the cursor; `?count=`, live cost overlay | ~180 |
| [`rigged`](src/rigged/main.ts) | the same rats baked on the CPU (`bakePose`) and posed on the GPU from one rest model (`makeCrowd({ rigged: true })`), side by side; `?vpm=100`, `?pairs=` | ~120 |
| [`nightwood`](src/nightwood/main.ts) | first person in a night forest at 50 voxels per metre (20 on a phone, 100 with `?vpm=100`): moonlight, lit windows, fireflies as point lights, fog as the view distance (`fog.distance`) | ~410 |
| [`temporal`](src/temporal/main.ts) | shadows and AO accumulated over frames, with fps and GPU time side by side for temporal off and on; `?temporal=1`, `?renderScale=` | ~350 |
| [`bench`](src/bench/main.ts) | the renderer benchmark: one deterministic scene with every expensive path, four fixed views, a `window.bench` hook; `?vpm=`, `?view=`, `?renderScale=`, `?quality=` | ~540 |

Shared (`src/shared/`): `boot.ts` (WebGPU init, the unsupported-browser card, the load tracker and
its loading screen), `loading-screen.ts` and `loading.ts` (the loading screen and load timeline),
`env.ts` (lighting and sky values for `FrameParams`), `voxGrid.ts` (MagicaVoxel model to Y-up dense
grid), and the worker plumbing of the heavy pages (`placement.ts`, `ground.ts`, `terrain.ts`,
`detail.ts`, `scale.ts`).

## Requirements

- [bun](https://bun.sh) 1.4 or newer
- A WebGPU-capable browser (Chrome, Edge, Safari 26+, Firefox with WebGPU enabled)

## Run

```sh
bun install    # from the workspace root (see below), not inside this repo
bun run dev
```

Open the printed `https://localhost:5173` URL, accept the self-signed certificate, and pick an
example from the landing page. The `minecraft-region` page needs a region file; take any
`r.X.Z.mca` from a Minecraft world's `region/` folder and drop it on the page.

## Local development with the engine

This repo depends on `@voxolith/renderer`, `@voxolith/engine` and the generator packages as
`workspace:*`. Clone `renderer`, `engine` and `generators` next to this one and run `bun install`
from a workspace root that lists them (`generators/*` for the generators). Once the engine is on
npm, swap the dependencies to version ranges.

## Deploy

Every push to `main` builds the app and publishes it to GitHub Pages at
<https://voxolith.github.io/examples/> via `.github/workflows/pages.yml`. The workflow checks out
`voxolith/renderer`, `voxolith/engine` and `voxolith/generators` next to the app and builds with
`BASE_PATH=/examples/`, so asset and fetch URLs resolve under the project path. Run the same locally with `BASE_PATH=/examples/ bun run build`.

## Theming

The UI uses the Voxolith design tokens in `src/brand/tokens.css` (dark navy by default, a paper
light theme via `prefers-color-scheme` or the toolbar toggle, persisted in `localStorage`). Those
files and the favicons are generated from the private `voxolith/branding` repo; edit them there
and re-run its sync script rather than here.

## License

MIT
