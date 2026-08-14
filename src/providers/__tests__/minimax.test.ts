import { test } from "vitest"
import { createMiniMaxProvider } from "../minimax"
import { classifyMinimaxError } from "../minimax/error-map"
import { at, bodyOf, headersOf, jsonResponse, mockFetch } from "./helpers"

const creds = { minimaxApiKey: "mm-key" }

test("minimax v2 submit builds content array with required fields", async () => {
  const mock = mockFetch([() => jsonResponse(200, { task_id: "t-1" })])
  const minimax = createMiniMaxProvider({}, creds)

  const handle = await minimax.videoGenerate.submit({
    model: "MiniMax-H3",
    prompt: "a dragon",
    firstFrame: { url: "https://x.test/f.png" },
    lastFrame: { url: "https://x.test/l.png" },
    options: { resolution: "768P", duration: 6, ratio: "16:9" },
  })

  expect(handle).toEqual({ providerId: "minimax", id: "t-1" })
  const first = at(mock.recorded, 0)
  expect(first.url).toBe("https://api.minimaxi.com/v2/video_generation")
  expect(headersOf(first)["authorization"]).toBe("Bearer mm-key")
  expect(bodyOf(first)).toEqual({
    model: "MiniMax-H3",
    content: [
      { type: "text", text: "a dragon" },
      { type: "image_url", image_url: { url: "https://x.test/f.png" }, role: "first_frame" },
      { type: "image_url", image_url: { url: "https://x.test/l.png" }, role: "last_frame" },
    ],
    resolution: "768P",
    duration: 6,
    ratio: "16:9",
  })
  mock.restore()
})

test("minimax submit rejects missing required resolution/duration", async () => {
  const minimax = createMiniMaxProvider({}, creds)
  await expect(
    minimax.videoGenerate.submit({ model: "MiniMax-H3", prompt: "x" }),
  ).rejects.toMatchObject({ category: "internal", message: expect.stringContaining("resolution") })
})

test("minimax poll uses v2 path param and task.content.url", async () => {
  const mock = mockFetch([
    () => jsonResponse(200, { task: { status: "queued" } }),
    () => jsonResponse(200, { task: { status: "running" } }),
    () =>
      jsonResponse(200, {
        task: { status: "succeeded", content: { url: "https://cdn.test/v.mp4" } },
      }),
    () =>
      jsonResponse(200, {
        task: { status: "failed", error: { code: 1026, message: "input sensitive" } },
      }),
    () => jsonResponse(200, { task: { status: "cancelled" } }),
  ])
  const minimax = createMiniMaxProvider({}, creds)
  const handle = { providerId: "minimax", id: "t-9" }

  expect(await minimax.videoGenerate.poll(handle)).toEqual({ state: "pending" })
  expect(await minimax.videoGenerate.poll(handle)).toEqual({ state: "running" })
  expect(await minimax.videoGenerate.poll(handle)).toEqual({
    state: "done",
    artifacts: [{ url: "https://cdn.test/v.mp4", mimeType: "video/mp4" }],
  })
  expect(at(mock.recorded, 0).url).toBe("https://api.minimaxi.com/v2/query/video_generation/t-9")
  const failed = await minimax.videoGenerate.poll(handle)
  expect(failed).toMatchObject({ state: "failed", error: { category: "moderation" } })
  const cancelled = await minimax.videoGenerate.poll(handle)
  expect(cancelled.state).toBe("failed")
  mock.restore()
})

test("minimax v2 http errors surface openai-style body", async () => {
  const mock = mockFetch([
    () => jsonResponse(429, { type: "error", error: { message: "rate limited" } }),
  ])
  const minimax = createMiniMaxProvider({}, creds)
  await expect(
    minimax.videoGenerate.submit({
      model: "MiniMax-H3",
      prompt: "x",
      options: { resolution: "768P", duration: 6 },
    }),
  ).rejects.toMatchObject({ category: "rate" })
  mock.restore()
})

test("minimax image maps image_urls and image_base64", async () => {
  const mock = mockFetch([
    () =>
      jsonResponse(200, {
        data: { image_urls: ["https://cdn.test/i.png"] },
        metadata: { success_count: 1 },
        base_resp: { status_code: 0 },
      }),
    () =>
      jsonResponse(200, {
        data: { image_base64: ["QUJD"] },
        base_resp: { status_code: 0 },
      }),
  ])
  const minimax = createMiniMaxProvider({}, creds)

  const url = await minimax.imageGenerate.create({ model: "image-01", prompt: "a cat" })
  expect(url.artifacts).toEqual([{ url: "https://cdn.test/i.png", mimeType: "image/png" }])
  expect(url.usage).toEqual({ native: { success_count: 1 } })

  const b64 = await minimax.imageGenerate.create({
    model: "image-01",
    prompt: "a cat",
    image: { url: "https://x.test/ref.png" },
  })
  expect(b64.artifacts).toEqual([{ base64: "QUJD", mimeType: "image/png" }])
  expect(bodyOf(at(mock.recorded, 1))["subject_reference"]).toEqual([
    { type: "character", image_file: "https://x.test/ref.png" },
  ])
  mock.restore()
})

test("minimax base_resp error throws classified error", async () => {
  const mock = mockFetch([
    () => jsonResponse(200, { base_resp: { status_code: 1004, status_msg: "invalid api key" } }),
  ])
  const minimax = createMiniMaxProvider({}, creds)
  await expect(
    minimax.imageGenerate.create({ model: "image-01", prompt: "x" }),
  ).rejects.toMatchObject({ category: "auth" })
  mock.restore()
})

test("minimax missing key throws auth", () => {
  expect(() => createMiniMaxProvider({}, {})).toThrow("missing MiniMax API key")
})

test("classifyMinimaxError maps official status codes", () => {
  expect(classifyMinimaxError(200, { base_resp: { status_code: 1004 } })).toBe("auth")
  expect(classifyMinimaxError(200, { base_resp: { status_code: 2049 } })).toBe("auth")
  expect(classifyMinimaxError(200, { base_resp: { status_code: 1002 } })).toBe("rate")
  expect(classifyMinimaxError(200, { base_resp: { status_code: 1008 } })).toBe("quota")
  expect(classifyMinimaxError(200, { base_resp: { status_code: 1026 } })).toBe("moderation")
  expect(classifyMinimaxError(200, { base_resp: { status_code: 1027 } })).toBe("moderation")
  expect(classifyMinimaxError(429, { error: { message: "x" } })).toBe("rate")
  expect(classifyMinimaxError(500, undefined)).toBe("internal")
  expect(classifyMinimaxError(400, { base_resp: { status_msg: "unknown" } })).toBeUndefined()
})
