import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import basicSsl from "@vitejs/plugin-basic-ssl";

const page = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // WebGPU needs a secure context; basic-ssl serves HTTPS on localhost + LAN.
  plugins: [basicSsl()],
  // @voxolith/render ships raw TypeScript with `?raw` shader imports; it must be
  // compiled with the app rather than pre-bundled.
  optimizeDeps: { exclude: ["@voxolith/render"] },
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
