import { describe, expect, test } from "vitest"
import { RUN_CONFIG_MEDIA_TYPE } from "../runPackage"
import { modelSupportsTask, requestFieldsForTask, TASKS, tasksForModel } from "../tasks"

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

test("every task accepts provider/model/json and declares options support", () => {
  for (const spec of Object.values(TASKS)) {
    if (spec.name === "resume") continue
    expect(spec.optional.options === true).toBe(true)
  }
})

describe("model→task derivation (single source for discoverability)", () => {
  test("text.generate maps to exactly text2text", () => {
    expect(tasksForModel({ capabilities: { "text.generate": {} } })).toEqual(["text2text"])
  })

  test("video.generate splits across tasks by ModelSupport filter", () => {
    // firstFrame+lastFrame but explicitly not text-only → image+frames only
    // (text2video's filter is textOnly !== false, mirrored exactly)
    expect(
      tasksForModel({
        capabilities: { "video.generate": { textOnly: false, firstFrame: true, lastFrame: true } },
      }),
    ).toEqual(["image2video", "frames2video"])
    // firstFrame only → no frames2video
    expect(tasksForModel({ capabilities: { "video.generate": { firstFrame: true } } })).toEqual([
      "text2video",
      "image2video",
    ])
    // textOnly → only text2video
    expect(tasksForModel({ capabilities: { "video.generate": { textOnly: true } } })).toEqual([
      "text2video",
    ])
    // {} support: textOnly undefined ≠ false → passes the text2video filter (mirrors pickModelForTask)
    expect(tasksForModel({ capabilities: { "video.generate": {} } })).toEqual(["text2video"])
  })

  test("image.generate splits by imageInput; embed and understand map 1:1", () => {
    expect(tasksForModel({ capabilities: { "image.generate": {} } })).toEqual(["text2image"])
    expect(tasksForModel({ capabilities: { "image.generate": { imageInput: true } } })).toEqual([
      "text2image",
      "image2image",
    ])
    expect(tasksForModel({ capabilities: { "image.understand": {} } })).toEqual(["image2text"])
    expect(tasksForModel({ capabilities: { "video.understand": {} } })).toEqual(["video2text"])
    expect(tasksForModel({ capabilities: { embed: {} } })).toEqual(["embed"])
  })

  test("resume has no capability; unrelated capabilities never match", () => {
    expect(modelSupportsTask({ capabilities: { "text.generate": {} } }, "resume")).toBe(false)
    expect(modelSupportsTask({ capabilities: {} }, "text2text")).toBe(false)
  })
})

describe("requestFieldsForTask contract", () => {
  test("text tasks accept opt-in packaging fields but not noPack", () => {
    const fields = requestFieldsForTask("text2text")
    expect(fields.has("tag")).toBe(true)
    expect(fields.has("output")).toBe(true)
    expect(fields.has("noPack")).toBe(false)
    expect(requestFieldsForTask("embed").has("tag")).toBe(true)
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
  expect(RUN_CONFIG_MEDIA_TYPE).toBe("application/vnd.creatifact.run.v1+json")
})
