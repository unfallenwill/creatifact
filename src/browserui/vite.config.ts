import { fileURLToPath } from "node:url"
import { svelte } from "@sveltejs/vite-plugin-svelte"
import { defineConfig } from "vite"
import { viteSingleFile } from "vite-plugin-singlefile"

// `npm run build:ui` compiles this sub-app into one self-contained HTML file
// (JS+CSS inlined by vite-plugin-singlefile); scripts/emit-ui.mjs then places
// it where src/browse.ts reads it at runtime. `npm run dev:ui` proxies API
// calls to a running `creatifact package serve --port 8765` instance.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [svelte(), viteSingleFile()],
  build: {
    outDir: "build",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8765",
      "/package": "http://127.0.0.1:8765",
    },
  },
})
