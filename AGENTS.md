# AGENTS.md: examples

Minimal example pages at https://voxolith.github.io/examples/. Each page is one
`<name>/index.html` plus `src/<name>/main.ts`, listed in `vite.config.ts` (`page(...)`) and in
`index.html`, and documented on the site (`content/docs/(guide)/examples/<name>.mdx`, with
`appPages` in `src/lib/shared.ts`).

Pages: hello-vox, orbit, minecraft-region, world, valley, nightwood, creature, swarm, instances,
rigged, temporal (plus the forest and village redirects).

## Commands

```sh
bun run --cwd examples dev     # https://localhost:5173
bun run --cwd examples build   # tsc --noEmit + vite build (what CI runs)
bun run --cwd examples bench   # tools/bench.ts: headless load-time breakdown of the forest scene (SPAN=2 for 2x2)
```

Siblings needed: renderer, engine, generators.

## Map

- `src/shared/boot.ts`: `boot(name, { blurb, steps })` (device, canvas, HUD, software warning,
  and the page's load tracker `load` with its loading screen `screen`) and `runLoop`. Every page
  reports its load into `load` (`trackRenderer`, the pool, layer and chunked world, app phases)
  and calls `screen.ready()` once it has drawn; minecraft-region passes `{ loading: false }` and
  opens a screen per dropped file.
- `src/shared/loading-screen.ts`: `showLoadingScreen(load, { title, blurb, steps })`: the
  full-canvas overlay until `ready()`, then a corner pill while listed steps still stream;
  `fail(err)` shows an error. **Each page lists its own steps** in its `main.ts` (`{ phase,
  label, background?, count? }`, in the order shown; `count: false` hides the `done/total`; `STEPS` holds the shared phases' defaults): to
  show a new phase, add an entry there; unlisted phases stay off the screen but on the tracker.
  `background: true` steps don't count towards the overall bar and go to the pill after
  `ready()`. `screen.setSteps` changes the list when it depends on the GPU (valley's rats). No
  `visibility` in its CSS (the smoke hides overlays with it).
- `src/shared/loading.ts`: `nextFrame` (resolves after the paint), `step(load, phase, fn)`
  (an app phase shown a frame before a blocking step), `prepared(renderer.prepare(...))` (awaits
  the pipeline compile; a failed one is left to the first frame), `markFrames(load, renderer)`
  (called beside `screen.ready()`: marks `first-frame`, then `converged` the first time
  `renderer.converging()` reads false) and `reportLoadTimeline` (`window.loadTimeline` and
  `window.loadOrigin` for the bench once the load is idle, `window.loadMarks` at once; under
  `?perf` the timeline in the console).
- `src/shared/offline.ts`: `offline()` registers the service worker (`registerServiceWorker` from
  `@voxolith/engine/pwa`), from `boot()` and the landing page. `vite.config.ts` emits it
  (`serviceWorker` from `@voxolith/engine/vite`, build only): every page and chunk is precached,
  `models/` is cached on use, and a public file a page fetches goes in its `include` list. It
  never registers on a dev server or on localhost / 127.0.0.1, so smoke and the benches never
  see it.
- **Pipelines:** every page creates its renderer with `deferPipelines: true` and awaits
  `prepared(renderer.prepare(needs))` before its first frame, so the `pipelines` step is the real
  compile. Pass `instances` / `parts` explicitly when the instances are not placed yet (the
  defaults read the current state); world gates its loop until the compile is done, since its
  loop starts before the models are generated.
- `src/shared/placement.ts` + `placement.worker.ts`: the page's scene worker (`sceneWorker()`,
  engine `makeSceneWorker` / `serveScene`) and `commitStatic(layer)` (`layer.commitAsync()`,
  falling back to a synchronous `commit()`). valley, nightwood and instances pass it as
  `makeInstanceLayer(renderer, { load, worker })`: `setStatic` only sends the models to be
  encoded, and the commit reserves the pools once, adds the models a few per frame and bakes, so
  neither upload nor placement blocks the main thread. Their upload row is `STEPS.encodedUpload`
  (`count: false`: the engine counts it in bricks, millions at 100 vox/m, so only the bar shows).
  valley streams its ground while the encodes run, rather than after them: measured, awaiting the
  uploads first gave the same first frame and a 220-240 ms task after it at 100 vox/m. The bench
  keeps the synchronous `setStatic` + `commit()`, so its `loadMs.place` stays the renderer's own
  placement cost.
- **Scene cache.** In production builds the scene worker keeps encodings and bakes in IndexedDB
  (`serveScene({ cache: { name: "voxolith-scene", maxBytes } })`, salted by its hashed URL; off
  in dev, like the model cache). It is capped at 2.5 GiB and the model cache
  (`world/gen.worker.ts`, `voxolith-models`) at 256 MiB, least recently used out first: sized so
  every page at every scale fits with a margin, from the per-page sizes in each worker file.
  valley and nightwood pass `modelKey: workers.modelKey` (every static model comes from the pool),
  so a warm visit never sends a model's bricks; instances grows its trees on the main thread and
  passes `hashModels: true` instead (a key of params and seed would survive a generator code
  change). The pages call
  `void worker.destroy()` (valley and nightwood after the fine swap), so nothing waits for the
  writes. A counted row shows
  `n cached`; a `count: false` row shows `cached` or `30% cached`.
- `src/shared/detail.ts`: coarse first, one swap (valley and nightwood at 50 and 100 vox/m).
  `coarseFactor(vpm, params)` (5 or 10; 1 at 20 or with `?coarse=0`), `stagedLoad(load)` (a
  tracker for the pool and the layer that files the fine stage's `models`, `upload` and
  `placement` under `fine.*`), `COARSE_STEPS` / `FINE_STEPS` (the rows; the fine ones are
  background rows for the corner pill) and `swapToFine` (`setStatic` + `commitStatic` in one task,
  then the `fine` mark). The pages ask for the 10 vox/m set and the fine set at once on one pool,
  place the coarse set with `scale: KC`, show the page at the coarse scene plus the ground within
  `?near=` metres (`world.readyAround`, plus half a chunk's diagonal), and swap once the fine set
  is generated and the unscaled pipeline compiled. Both stages pass `modelKey`, so a warm visit
  reads both from the scene cache.
- `src/shared/ground.ts` + `ground.worker.ts`: the streamed ground filled on workers
  (engine `makeChunkFillPool` / `serveChunks`, `makeChunkedWorld({ fill, boxes })`): `groundFill(init)`
  with a `GroundInit` (gen-terrain `fineTerrainInit` for valley and nightwood, `terrainInit` plus
  `topOverrideData` for world), `groundWorkers()` (cores less six, 1 to 6: the generator pool
  takes four, the scene worker one; 6 measured best on valley 100) and `buildAround(world, x, z, r, budgetMs)`, the loading
  screen's wait (a 40 ms `step` budget there; the frame loops use 8). The description is taken
  when the pool is made, so level and settle the top override first. `generate` still runs per
  applied chunk (valley's `built` counter, world's model blits). nightwood destroys its pool once
  its reach is built, world once the whole valley is.
- `src/shared/terrain.ts` + `terrain.worker.ts`: `terrainOffThread(params, seed)`, a terrain
  whose height map is sampled on up to six workers in bands of rows (gen-terrain `terrainHeight`
  is pure per column; the worker bundles gen-terrain only) and rebuilt here from the heights
  (`generateTerrain(params, seed, { heights })`); falls back to this thread. valley and world use
  it; valley overlaps it with the model requests and the renderer (the palette takes the
  terrain's roles from `buildRoles`, which need no heights).
- `src/shared/scale.ts`: the voxel scale of `valley` and `nightwood`: `isPhone` (the phone
  profile test), `pickScale` (`?vpm=` snapped to 20, 50 or 100; default 50, 20 on a phone; the
  HUD's scale button steps between the default and one scale finer).
- `src/world/layout.ts`: the shared valley design (terrain, sites, houses, pads, paths,
  scatter). `world` (10 vox/m) and `valley` (50 vox/m by default, 20 on a phone, 100 with
  `?vpm=100`) both read it; change the layout there, never in one page. The valley's rats only
  appear where gen-creature's `realSizeAt` holds (100 vox/m); `?rats=N` forces them.
- `src/world/gen.worker.ts`: the shared generator worker. It caches models in IndexedDB in
  production builds (`serveGenerators({ cache })`, salted by the worker's hashed URL).
- `src/nightwood/`: first person in a night forest at 50 vox/m (20 on a phone, 100 with
  `?vpm=100`), with fog as the view distance
  (`fog.distance`). This is the lighting showcase the renderer's roadmap is measured against.

## Rules for pages

- An example teaches one thing. Keep a page short and self-contained, and put shared plumbing in
  `src/shared/`.
- Every page documents its URL options in its header comment and on its docs page.
- Heavy pages give phones a lighter profile: a touch-only pointer, or storage bindings under
  512 MiB, get fewer voxels per metre and a lower preset; `?full` overrides.
- Pages that render continuously with a still camera pass `retryAfterMs: Infinity` to
  `makePerf` and call `perf.reprobe()` when the view moves.
- A page that only draws after user input must be declared `needsInput` in the maintainer's
  smoke list, or the smoke run reports it blank.

## App rules

- **Deployment.** Every push to `main` deploys to GitHub Pages under `/<repo>/`
  (`.github/workflows/pages.yml`). The workflow checks the sibling repos out alongside to satisfy
  `workspace:*` and builds with `BASE_PATH=/<repo>/`. Never hard-code absolute URLs: fetch with
  `import.meta.env.BASE_URL` and link pages relatively. CI's required job is `build`.
- **Vite.** `optimizeDeps: { exclude: ["@voxolith/renderer"] }` stays in `vite.config.ts`
  (the renderer ships raw TypeScript and imports shaders with `?raw`).
- **Input** comes from `@voxolith/engine/input` only, never raw listeners:
  - one `createInput(canvas, { loop })` per surface;
  - `prepareSurface(canvas)` instead of per-app `touch-action` CSS;
  - `makeOrbitController` / `makeLookController` for cameras;
  - `recogniseGestures` for taps, `makeActions` for game controls, `makeTouchControls` for
    on-screen sticks.
- **Render on demand.** Use `makeFrameLoop`: `invalidate()` on camera, scene or viewport changes,
  and `setContinuous(true)` only while something animates (water on screen counts). Quality is
  the engine's presets behind a select stored as `voxolith-quality`. Software adapters
  (`gpu.software`) warn and start on Low.
- **Branding.** `src/brand/tokens.css` and `src/brand/theme.ts` are generated copies from the
  private `branding` repo: never edit them here. Use the tokens (`--bg`, `--surface`,
  `--accent`, ...), never hex colours in CSS. Dark is the default theme.

## Working in the Voxolith repos

- **Layout.** Every Voxolith repo is checked out side by side under one bun workspace root, and
  depends on its siblings as `"workspace:*"`. Run `bun install` from that root, never inside a
  repo. [CONTRIBUTING](https://github.com/voxolith/.github/blob/main/CONTRIBUTING.md) lists
  which siblings each repo needs.
- **Toolchain: bun only.** There is no npm or node step anywhere. It is TypeScript 7 and Vite 8;
  scripts run `tsc`, `vite` and `bun tools/x.ts`. Use current dependency versions.
- **`tsconfig.base.json` is byte-identical in every repo**, because consumers compile the
  renderer's and engine's sources under their own flags. Change it everywhere or nowhere.
- **WebGPU, not WebGL.** Dev servers are HTTPS (`@vitejs/plugin-basic-ssl`), because WebGPU needs a
  secure context. Checks cannot see pixels: anything that changes what is drawn must be looked
  at in a WebGPU browser, with a before/after screenshot in the pull request.
- **Docs live on the site** ([voxolith.github.io](https://voxolith.github.io/docs/), repo
  `voxolith.github.io`). READMEs stay short and link there. The API reference is generated from
  the sources, so doc comments are published content: every exported symbol has a `/** */`, and
  entry files open with `@packageDocumentation`.
- **Credit research.** When an idea comes from a paper, cite it (authors, title, venue, DOI) in
  the code comment, in the docs (the page's References and `/docs/credits/`) and in the commit
  body. Check the citation against the paper or DataCite; don't cite from memory.
- **Prose.** British spelling in prose and comments (`colour`, `normalise`); identifiers follow the
  web platform (`lightColor`). "Voxolith" is capitalised in prose; lowercase is only for the
  wordmark.
- **Commits.** History is linear and read as prose:
  - The subject says what is now true, in plain words: no `feat:` prefixes, no trailing full
    stop, about 70 characters at most.
  - The body says why, what it costs and what it deliberately does not do, wrapped at about 72
    columns.
  - One change per commit. AI-assisted commits keep their `Co-Authored-By` trailer.
  - Pull requests are squash-merged or rebased; there are no merge commits.
  - Don't push, tag or publish unless asked.
- **Community files** (CONTRIBUTING with the AI policy, CODE_OF_CONDUCT, SECURITY, templates) live
  once in `voxolith/.github` and apply org-wide; don't copy them in here.
- **CI's job names are required checks** on `main` (rulesets). Renaming a job breaks merging.
