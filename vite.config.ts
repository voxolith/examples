import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import basicSsl from "@vitejs/plugin-basic-ssl";

const page = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // GitHub Pages serves project sites under /<repo>/; the deploy workflow sets BASE_PATH.
  base: process.env.BASE_PATH ?? "/",
  // WebGPU needs a secure context; basic-ssl serves HTTPS on localhost + LAN.
  plugins: [basicSsl()],
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
      },
    },
  },
});
