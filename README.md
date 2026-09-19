# Voxolith examples

Minimal, runnable pages for [`@voxolith/render`](https://github.com/voxolith/render), the WebGPU
voxel raymarching engine. Each example is one `main.ts` with comments; the shared helpers in
`src/shared/` are tiny and meant to be copied.

| example | shows | lines |
|---|---|---|
| [`hello-vox`](src/hello-vox/main.ts) | load a `.vox`, `parseVox`, `createRenderer`, `OccupancyGrid`, `makeCamera`, render loop | ~35 |
| [`orbit`](src/orbit/main.ts) | writing a procedural grid by hand, `makeOrbitControl`, wheel zoom, `setFloor` | ~55 |
| [`minecraft-region`](src/minecraft-region/main.ts) | drop a Minecraft `.mca`, `buildMinecraftRegion` crop and downsample, `firstPersonFrame` free-fly | ~75 |

Shared: `boot.ts` (WebGPU init and the unsupported-browser card), `env.ts` (lighting and sky
values for `FrameParams`), `voxGrid.ts` (MagicaVoxel model to Y-up dense grid).

## Requirements

- [bun](https://bun.sh) 1.4 or newer
- A WebGPU-capable browser (Chrome, Edge, Safari 26+, Firefox with WebGPU enabled)

## Run

```sh
bun install
bun run dev
```

Open the printed `https://localhost:5173` URL, accept the self-signed certificate, and pick an
example from the landing page. The `minecraft-region` page needs a region file; take any
`r.X.Z.mca` from a Minecraft world's `region/` folder and drop it on the page.

## Local development with the engine

This repo depends on `@voxolith/render` as `workspace:*`. Clone it next to this one and run
`bun install` from a workspace root that lists both folders. Once the engine is on npm, swap the
dependency to a version range.

## License

MIT
