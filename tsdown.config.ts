import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["./src/index.ts", "./src/providers/index.ts"],
  format: ["esm"],
  platform: "node",
  minify: true,
  target: "esnext",
  dts: true,
  sourcemap: true,
})
