// Place the built single-file UI where the CLI reads it at runtime:
// src/browserui/app.html (dev via tsx, and vitest) and, when a bundle
// exists, dist/browserui/app.html next to dist/index.mjs (same relative
// shape as src, so one URL resolves in both layouts).
import { cpSync, existsSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const built = join(root, "src", "browserui", "build", "index.html")
const srcDest = join(root, "src", "browserui", "app.html")
const distDir = join(root, "dist")

if (!existsSync(built)) {
  console.error("emit-ui: src/browserui/build/index.html missing — run 'npm run build:ui' first")
  process.exit(1)
}
cpSync(built, srcDest)
if (existsSync(distDir)) {
  mkdirSync(join(distDir, "browserui"), { recursive: true })
  cpSync(built, join(distDir, "browserui", "app.html"))
  console.log("emit-ui: wrote src/browserui/app.html and dist/browserui/app.html")
} else {
  console.log("emit-ui: wrote src/browserui/app.html (no dist/ yet)")
}
