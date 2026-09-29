import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { serviceWorker } from "@voxolith/engine/vite";

const page = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // GitHub Pages serves project sites under /<repo>/; the deploy workflow sets BASE_PATH.
  base: process.env.BASE_PATH ?? "/",
  // WebGPU needs a secure context; basic-ssl serves HTTPS on localhost + LAN.
  // A service worker (build only) caches every page on first visit, so a second visit, to any
  // page, works offline. Generated models live in the pages' IndexedDB cache, not here.
  plugins: [
    basicSsl(),
    serviceWorker({
      name: "examples",
      runtime: [{ match: "models/" }],
      // Public files the pages and their HTML fetch (the bundle is precached anyway).
      include: [
        "favicon.svg",
        "favicon-32.png",
        "favicon-192.png",
        "apple-touch-icon.png",
        "brand/logo-mark.svg",
        "brand/lockup.svg",
        "brand/lockup-dark.svg",
        "models/cat-sit.vox",
        "forest/index.html",
        "village/index.html",
      ],
    }),
  ],
  // @voxolith/renderer ships raw TypeScript with `?raw` shader imports; it must be
  // compiled with the app rather than pre-bundled.
  optimizeDeps: { exclude: ["@voxolith/renderer"] },
  server: { host: true },
  build: {
    rollupOptions: {
      input: {
        index: page("index.html"),
        "hello-vox": page("hello-vox/index.html"),
        orbit: page("orbit/index.html"),
        "minecraft-region": page("minecraft-region/index.html"),
        world: page("world/index.html"),
        creature: page("creature/index.html"),
        rigged: page("rigged/index.html"),
        nightwood: page("nightwood/index.html"),
        swarm: page("swarm/index.html"),
        instances: page("instances/index.html"),
        valley: page("valley/index.html"),
        temporal: page("temporal/index.html"),
        bench: page("bench/index.html"),
      },
    },
  },
});
