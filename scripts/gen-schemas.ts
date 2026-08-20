import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { buildManifestSchemaJson, requestFileSchemaJson } from "../src/contract"

/**
 * Regenerate schemas/*.json from src/contract.ts (the single source of
 * truth). Run via `npm run gen:schemas`; CI enforces via the drift gate in
 * src/__tests__/schema.test.ts — hand edits to schemas/ are rejected.
 */

const schemasDir = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas")
mkdirSync(schemasDir, { recursive: true })

const files: Array<[string, () => Record<string, unknown>]> = [
  ["creatifact-request.schema.json", requestFileSchemaJson],
  ["creatifact-build.schema.json", buildManifestSchemaJson],
]

for (const [name, build] of files) {
  const path = join(schemasDir, name)
  writeFileSync(path, `${JSON.stringify(build(), null, 2)}\n`)
  console.log(`wrote ${path}`)
}
