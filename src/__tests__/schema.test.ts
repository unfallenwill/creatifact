import { readFileSync } from "node:fs"
import {
  buildManifestSchemaJson,
  generateRequestFields,
  REFERENCEABLE,
  requestFileCommands,
  requestFileSchemaJson,
  stableStringify,
} from "../contract"
import { commandRequestFromFields } from "../requestFile"
import { requestFieldsForTask, TASKS } from "../tasks"

/**
 * Contract gates. schemas/*.json are GENERATED from src/contract.ts
 * (`npm run gen:schemas`) — these tests fail when the checked-in files drift
 * from the contract, when a registry task accepts a field the contract does
 * not know, when a documented command stops being executable, or when
 * README's referenceable-fields section goes stale.
 */

test("schemas/creatifact-request.schema.json matches the contract", () => {
  const checkedIn = JSON.parse(readFileSync("schemas/creatifact-request.schema.json", "utf8"))
  expect(
    stableStringify(checkedIn) === stableStringify(requestFileSchemaJson()),
    "schemas/creatifact-request.schema.json is out of sync with src/contract.ts — run `npm run gen:schemas` and commit the result",
  ).toBe(true)
})

test("schemas/creatifact-build.schema.json matches the contract", () => {
  const checkedIn = JSON.parse(readFileSync("schemas/creatifact-build.schema.json", "utf8"))
  expect(
    stableStringify(checkedIn) === stableStringify(buildManifestSchemaJson()),
    "schemas/creatifact-build.schema.json is out of sync with src/contract.ts — run `npm run gen:schemas` and commit the result",
  ).toBe(true)
})

test("every registry task's -f fields exist in the contract tables", () => {
  const known = new Set(Object.keys(generateRequestFields))
  for (const task of Object.keys(TASKS)) {
    for (const field of requestFieldsForTask(task as keyof typeof TASKS)) {
      expect(known.has(field), `generate.${task}: '${field}'`).toBe(true)
    }
  }
})

/** Minimal fields that let each command pass commandRequestFromFields. */
const MINIMAL_FIELDS: Record<string, Record<string, unknown>> = {
  build: { tag: "x:1" },
  push: { ref: "x:1" },
  pull: { ref: "x:1" },
  "auth.login": { registry: "localhost:5000" },
  "auth.logout": { registry: "localhost:5000" },
  "config.get": { key: "a" },
  "config.set": { key: "a", value: 1 },
}

test("every documented request-file command is executable", () => {
  for (const command of requestFileCommands()) {
    const fields = MINIMAL_FIELDS[command] ?? {}
    expect(() => commandRequestFromFields(command, fields), command).not.toThrow()
  }
})

/** Narrow a generated-schema fragment to the keys this test inspects. */
function asBranch(v: unknown): {
  required?: string[]
  properties?: Record<string, unknown>
  additionalProperties?: unknown
  items?: unknown
  anyOf?: unknown[]
} {
  return v as {
    required?: string[]
    properties?: Record<string, unknown>
    additionalProperties?: unknown
    items?: unknown
    anyOf?: unknown[]
  }
}

test("request schema branches are closed and as strong as the runtime", () => {
  const schema = requestFileSchemaJson()
  const root = schema as { $defs?: Record<string, unknown>; anyOf?: unknown[] }
  const defs = root.$defs ?? {}
  const commands = requestFileCommands()
  for (const command of commands) {
    const single = asBranch(defs[`single.${command}`])
    expect(single.additionalProperties, `${command}: single is closed`).toBe(false)
    const expected = [
      "command",
      ...Object.keys(MINIMAL_FIELDS[command] ?? {}).filter((k) => k !== "command"),
    ].sort()
    expect([...(single.required ?? [])].sort(), `${command}: single required`).toEqual(expected)
    // The -f face mirrors one command line exactly: no `name`, `$schema` only.
    expect(Object.keys(single.properties ?? {}), `${command}: no name`).not.toContain("name")
    expect(Object.keys(single.properties ?? {}), `${command}: has $schema`).toContain("$schema")
  }
  expect(root.anyOf?.length, "one branch per command").toBe(commands.length)
})
test("README's referenceable-outputs bullets match the contract", () => {
  const readme = readFileSync("README.md", "utf8")
  // The "A stage may reference these outputs from an earlier stage:" paragraph,
  // followed by bullets like "- `tag`, `digest`, and `outputDir`". Backticked
  // `artifacts[N].…` forms are pipeline syntax, not referenceable-field names.
  const lines = readme.split("\n")
  const sentinel = "A stage may reference these outputs from an earlier stage:"
  const start = lines.findIndex((line) => line.endsWith(sentinel))
  expect(start, "README must keep the referenceable-outputs paragraph").toBeGreaterThan(-1)
  const documented: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") continue // blank line between the paragraph and its bullets
    if (!line.startsWith("- ")) break
    documented.push(
      ...[...line.matchAll(/`([^`]+)`/g)]
        .map((x) => x[1] as string)
        .filter((f) => !f.includes("[")),
    )
  }
  const expected = new Set(Object.values(REFERENCEABLE).flat())
  expect([...new Set(documented)].sort()).toEqual([...expected].sort())
})
