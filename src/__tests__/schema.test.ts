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
    const step = asBranch(defs[`step.${command}`])
    // Closed branches: no key outside the contract's field set validates.
    expect(single.additionalProperties, `${command}: single is closed`).toBe(false)
    expect(step.additionalProperties, `${command}: step is closed`).toBe(false)
    // Requiredness mirrors the runtime: exactly `command` plus whatever the
    // minimal-executable fields are (nothing for generate.* — the CLI
    // overlay may complete the request).
    const expected = [
      "command",
      ...Object.keys(MINIMAL_FIELDS[command] ?? {}).filter((k) => k !== "command"),
    ].sort()
    expect([...(single.required ?? [])].sort(), `${command}: single required`).toEqual(expected)
    // Same requiredness in pipeline steps: steps run the very same parsers.
    expect([...(step.required ?? [])].sort(), `${command}: step required`).toEqual(expected)
    // Form-specific keys: `name` belongs to steps, `$schema` to the root.
    expect(Object.keys(single.properties ?? {}), `${command}: single has no name`).not.toContain(
      "name",
    )
    expect(Object.keys(step.properties ?? {}), `${command}: step has no $schema`).not.toContain(
      "$schema",
    )
  }
  const stepsForm = asBranch(root.anyOf?.[0])
  expect(stepsForm.additionalProperties, "steps form is closed").toBe(false)
  expect(stepsForm.required, "steps form requires steps").toEqual(["steps"])
  const stepsProp = asBranch(stepsForm.properties?.["steps"])
  const items = asBranch(stepsProp.items)
  expect(items.anyOf?.length, "steps items cover every command").toBe(commands.length)
})

test("README's referenceable-fields section matches the contract", () => {
  const readme = readFileSync("README.md", "utf8")
  // Bullets like "- `build` → `tag`/`digest`/`outputDir`" (the arrow is a
  // Unicode →); trailing prose after the field list is allowed.
  const documented = new Map<string, string[]>()
  for (const line of readme.split("\n")) {
    const m = /^- `([a-z]+)` \u2192 (.+)$/.exec(line)
    if (m === null) continue
    const kind = (m[1] ?? "") as string
    const rest = m[2] ?? ""
    // Plain scalar fields only; `artifacts[N].…` expression forms are
    // pipeline syntax, not referenceable-field names.
    const fields = [...rest.matchAll(/`([^`]+)`/g)]
      .map((x) => x[1] as string)
      .filter((f) => !f.includes("["))
    if (fields.length > 0 && !documented.has(kind)) documented.set(kind, fields)
  }
  expect([...documented.keys()].sort()).toEqual(["build", "generate", "pull", "push"])
  const table = REFERENCEABLE as Record<string, readonly string[] | undefined>
  for (const [kind, fields] of documented) {
    expect(fields.sort(), kind).toEqual([...(table[kind] ?? [])].sort())
  }
})
