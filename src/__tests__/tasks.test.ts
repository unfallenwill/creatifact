import { describe, expect, test } from "vitest"
import { GEN_CONFIG_MEDIA_TYPE } from "../genPackage"
import { TASKS, requestFieldsForTask } from "../tasks"

test("TASKS registry keys cover all generation tasks plus resume", () => {
  expect(Object.keys(TASKS).sort()).toEqual([
    "embed",
    "frames2video",
    "image2image",
    "image2text",
    "image2video",
    "resume",
    "text2image",
    "text2text",
    "text2video",
    "video2text",
  ])
})

test("every task has a usage string naming itself", () => {
  for (const spec of Object.values(TASKS)) {
    expect(spec.usage).toContain(`openmmcli generate ${spec.name}`)
  }
})

describe("requestFieldsForTask contract", () => {
  test("text tasks carry no media packaging fields", () => {
    expect(requestFieldsForTask("text2text").has("tag")).toBe(false)
    expect(requestFieldsForTask("text2text").has("output")).toBe(false)
  })

  test("media tasks allow packaging fields", () => {
    const fields = requestFieldsForTask("text2image")
    expect(fields.has("tag")).toBe(true)
    expect(fields.has("noPack")).toBe(true)
    expect(fields.has("output")).toBe(true)
    expect(fields.has("images")).toBe(false)
  })

  test("frames2video requires both frame fields", () => {
    const fields = requestFieldsForTask("frames2video")
    expect(fields.has("firstFrame")).toBe(true)
    expect(fields.has("lastFrame")).toBe(true)
  })

  test("resume accepts handle, output, timing; not media fields", () => {
    const fields = requestFieldsForTask("resume")
    expect(fields.has("handle")).toBe(true)
    expect(fields.has("output")).toBe(true)
    expect(fields.has("tag")).toBe(false)
    expect(fields.has("prompt")).toBe(false)
  })
})

test("gen recipe media type is versioned", () => {
  expect(GEN_CONFIG_MEDIA_TYPE).toBe("application/vnd.openmm.gen.v1+json")
})
