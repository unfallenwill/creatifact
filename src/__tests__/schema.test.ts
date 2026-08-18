import { readFileSync } from "node:fs"
import { requestFieldsForTask, TASKS } from "../generate"

/**
 * The task registry is the single source of truth: the checked-in JSON
 * schemas must stay in sync with it or CI fails here.
 */

const REQUEST_SCHEMA = JSON.parse(readFileSync("schemas/openmm-request.schema.json", "utf8")) as {
  properties: Record<string, unknown>
  "properties-command"?: never
}

const BUILD_SCHEMA = JSON.parse(readFileSync("schemas/openmm-build.schema.json", "utf8")) as {
  properties: Record<string, { properties?: Record<string, unknown> }>
}

test("request schema command enum covers every registry task", () => {
  const command = REQUEST_SCHEMA.properties["command"] as { enum: string[] }
  for (const task of Object.keys(TASKS)) {
    expect(command.enum).toContain(`generate.${task}`)
  }
})

test("every registry request field exists in the request schema", () => {
  const allFields = new Set<string>()
  for (const task of Object.keys(TASKS)) {
    for (const field of requestFieldsForTask(task as keyof typeof TASKS)) {
      allFields.add(field)
    }
  }
  for (const field of allFields) {
    expect(REQUEST_SCHEMA.properties[field]).toBeDefined()
  }
})

test("generate-related schema properties are all known registry fields", () => {
  const allFields = new Set<string>()
  for (const task of Object.keys(TASKS)) {
    for (const field of requestFieldsForTask(task as keyof typeof TASKS)) {
      allFields.add(field)
    }
  }
  const generateFields = new Set([
    ...allFields,
    "command",
    "steps",
    "$schema",
    // shared with non-generate commands
    "file",
    "dir",
    "annotations",
    "ref",
    "layout",
    "registry",
    "username",
    "password",
    "plainHttp",
    "key",
    "value",
    "output",
    "tag",
    "timeout",
    "interval",
    "json",
  ])
  for (const prop of Object.keys(REQUEST_SCHEMA.properties)) {
    expect(generateFields.has(prop)).toBe(true)
  }
})

test("steps pipeline form is declared with unique-name step items", () => {
  const steps = REQUEST_SCHEMA.properties["steps"] as {
    type: string
    minItems: number
    items: { required: string[]; properties: Record<string, unknown> }
  }
  expect(steps.type).toBe("array")
  expect(steps.minItems).toBe(1)
  expect(steps.items.required).toEqual(["command"])
  expect(steps.items.properties["name"]).toBeDefined()
  const oneOf = (REQUEST_SCHEMA as unknown as { oneOf?: { required: string[] }[] }).oneOf
  expect(oneOf).toEqual([{ required: ["command"] }, { required: ["steps"] }])
})

test("build schema gen fields match the recipe spec", () => {
  const genProps = BUILD_SCHEMA.properties["gen"]?.properties ?? {}
  expect(Object.keys(genProps).sort()).toEqual(
    [
      "task",
      "provider",
      "model",
      "prompt",
      "system",
      "options",
      "images",
      "firstFrame",
      "lastFrame",
      "inputs",
    ].sort(),
  )
  const taskEnum = (genProps["task"] as { enum: string[] }).enum
  for (const task of Object.keys(TASKS)) {
    if (task !== "resume") expect(taskEnum).toContain(task)
  }
})
