import { test } from "vitest"
import { createArkProvider } from "../ark"
import { classifyArkError } from "../ark/error-map"
import { at, bodyOf, headersOf, jsonResponse, mockFetch } from "./helpers"

const creds = { arkApiKey: "test-key" }

test("ark video submit builds content array with frame roles and returns handle", async () => {
  const mock = mockFetch([() => jsonResponse(200, { id: "task-1" })])
  const ark = createArkProvider({}, creds)

  const handle = await ark.videoGenerate.submit({
    model: "doubao-seedance-2.0",
    prompt: "a dragon",
    firstFrame: { url: "https://x.test/first.png" },
    lastFrame: { base64: "AAA=" },
    options: { resolution: "1080p" },
  })

  expect(handle).toEqual({ providerId: "ark", id: "task-1" })
  const first = at(mock.recorded, 0)
  expect(first.url).toBe("https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks")
  expect(headersOf(first)["authorization"]).toBe("Bearer test-key")
  expect(bodyOf(first)).toEqual({
    model: "doubao-seedance-2.0",
    resolution: "1080p",
    content: [
      { type: "text", text: "a dragon" },
      { type: "image_url", image_url: { url: "https://x.test/first.png" }, role: "first_frame" },
      {
        type: "image_url",
        image_url: { url: "data:application/octet-stream;base64,AAA=" },
        role: "last_frame",
      },
    ],
  })
  mock.restore()
})

test("ark video poll maps task states", async () => {
  const states = [
    { status: "queued" },
    { status: "running" },
    {
      status: "succeeded",
      content: { video_url: "https://cdn.test/v.mp4" },
      usage: { completion_tokens: 100 },
    },
    { status: "failed", error: { code: "SensitiveContentDetected", message: "bad" } },
    { status: "cancelled" },
    { status: "expired" },
  ]
  const mock = mockFetch(states.map((s) => () => jsonResponse(200, s)))
  const ark = createArkProvider({}, creds)
  const handle = { providerId: "ark", id: "t" }

  expect(await ark.videoGenerate.poll(handle)).toEqual({ state: "pending" })
  expect(await ark.videoGenerate.poll(handle)).toEqual({ state: "running" })
  expect(await ark.videoGenerate.poll(handle)).toEqual({
    state: "done",
    artifacts: [{ url: "https://cdn.test/v.mp4", mimeType: "video/mp4", expiresAt: undefined }],
    usage: { native: { completion_tokens: 100 } },
  })
  expect(await ark.videoGenerate.poll(handle)).toEqual({
    state: "failed",
    error: { category: "moderation", raw: { code: "SensitiveContentDetected", message: "bad" } },
  })
  expect(await ark.videoGenerate.poll(handle)).toMatchObject({ state: "failed" })
  expect(await ark.videoGenerate.poll(handle)).toMatchObject({ state: "failed" })
  mock.restore()
})

test("ark image generate is synchronous", async () => {
  const mock = mockFetch([
    () => jsonResponse(200, { data: [{ url: "https://cdn.test/i.png" }], usage: { g: 1 } }),
  ])
  const ark = createArkProvider({}, creds)

  const result = await ark.imageGenerate.create({
    model: "doubao-seedream-4.0-250828",
    prompt: "a cat",
    image: { url: "https://x.test/ref.png" },
  })

  expect(result.artifacts).toEqual([
    { url: "https://cdn.test/i.png", base64: undefined, mimeType: "image/png" },
  ])
  const first = at(mock.recorded, 0)
  expect(first.url).toContain("/images/generations")
  expect(bodyOf(first)["image"]).toBe("https://x.test/ref.png")
  mock.restore()
})

test("ark understand maps files to image_url vs video_url", async () => {
  const mock = mockFetch([
    () => jsonResponse(200, { choices: [{ message: { content: "a cat" } }] }),
    () => jsonResponse(200, { choices: [{ message: { content: "a clip" } }] }),
  ])
  const ark = createArkProvider({}, creds)

  await ark.imageUnderstand.create({
    model: "doubao-1.5-vision-pro",
    messages: [
      { role: "user", content: ["what is this", { file: { url: "https://x.test/a.png" } }] },
    ],
  })
  await ark.videoUnderstand.create({
    model: "doubao-1.5-vision-pro",
    messages: [{ role: "user", content: [{ file: { url: "https://x.test/a.mp4" } }] }],
  })

  const imgBody = bodyOf(at(mock.recorded, 0))
  const vidBody = bodyOf(at(mock.recorded, 1))
  const imgMessages = imgMessagesOf(imgBody)
  const vidMessages = imgMessagesOf(vidBody)
  expect(imgMessages[0]?.content[1]).toEqual({
    type: "image_url",
    image_url: { url: "https://x.test/a.png" },
  })
  expect(vidMessages[0]?.content[0]).toEqual({
    type: "video_url",
    video_url: { url: "https://x.test/a.mp4" },
  })
  mock.restore()
})

function imgMessagesOf(body: Record<string, unknown>) {
  return body["messages"] as Array<{ content: Array<Record<string, unknown>> }>
}

test("ark embed returns vectors and dimensions", async () => {
  const mock = mockFetch([
    () => jsonResponse(200, { data: [{ embedding: [0.1, 0.2] }], usage: { tokens: 3 } }),
  ])
  const ark = createArkProvider({}, creds)

  const result = await ark.embed.create({ model: "doubao-embedding", inputs: ["hello"] })
  expect(result).toEqual({
    vectors: [[0.1, 0.2]],
    dimensions: 2,
    usage: { native: { tokens: 3 } },
  })
  mock.restore()
})

test("ark missing key throws auth error", () => {
  expect(() => createArkProvider({}, {})).toThrow("missing Ark API key")
})

test("classifyArkError maps codes", () => {
  expect(classifyArkError(401, undefined)).toBe("auth")
  expect(classifyArkError(400, { error: { code: "SensitiveContentDetected" } })).toBe("moderation")
  expect(classifyArkError(400, { error: { code: "Arrears" } })).toBe("quota")
  expect(classifyArkError(400, { error: { code: "WhateverElse" } })).toBeUndefined()
})
