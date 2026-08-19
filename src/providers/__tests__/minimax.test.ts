import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "vitest"
import { createMiniMaxProvider } from "../minimax"
import { classifyMinimaxError } from "../minimax/error-map"
import {
  MINIMAX_DEFAULT_MODELS,
  MINIMAX_MODELS,
  MINIMAX_VIDEO_MODEL_MODES,
} from "../minimax/models"
import { at, bodyOf, headersOf, jsonResponse, mockFetch } from "./helpers"

const settings = { apiKey: "mm-key" }

test("minimax v2 submit builds content array with required fields", async () => {
  const mock = mockFetch([() => jsonResponse(200, { task_id: "t-1" })])
  const minimax = createMiniMaxProvider(settings)

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
  const minimax = createMiniMaxProvider(settings)
  await expect(
    minimax.videoGenerate.submit({ model: "MiniMax-H3", prompt: "x" }),
  ).rejects.toMatchObject({ category: "invalid", message: expect.stringContaining("resolution") })
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
  const minimax = createMiniMaxProvider(settings)
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
  const minimax = createMiniMaxProvider(settings)
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
        data: { image_urls: ["https://cdn.test/i.jpeg"] },
        metadata: { success_count: 1 },
        base_resp: { status_code: 0 },
      }),
    () =>
      jsonResponse(200, {
        data: { image_base64: ["QUJD"] },
        base_resp: { status_code: 0 },
      }),
  ])
  const minimax = createMiniMaxProvider(settings)

  const url = await minimax.imageGenerate.create({ model: "image-01", prompt: "a cat" })
  expect(url.artifacts).toEqual([{ url: "https://cdn.test/i.jpeg", mimeType: "image/jpeg" }])
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
  const minimax = createMiniMaxProvider(settings)
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

test("minimax poll rejects a foreign provider handle", async () => {
  const minimax = createMiniMaxProvider(settings)
  await expect(minimax.videoGenerate.poll({ providerId: "ark", id: "t" })).rejects.toMatchObject({
    category: "invalid",
  })
})

test("minimax subject_reference infers mime from local file extension", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "mm-subject-"))
  try {
    const jpg = join(tmp, "photo.jpg")
    await writeFile(jpg, Buffer.from("jpeg-data"))
    const mock = mockFetch([
      () =>
        jsonResponse(200, {
          data: { image_urls: ["https://cdn.test/x.png"] },
          base_resp: { status_code: 0 },
        }),
    ])
    const minimax = createMiniMaxProvider(settings)

    await minimax.imageGenerate.create({
      model: "image-01",
      prompt: "x",
      image: { localPath: jpg },
    })

    const body = bodyOf(at(mock.recorded, 0))
    const refs = body["subject_reference"] as Array<{ image_file: string }>
    expect(refs[0]?.image_file).toMatch(/^data:image\/jpeg;base64,/)
    mock.restore()
  } finally {
    await rm(tmp, { recursive: true })
  }
})

test("classifyMinimaxError maps 2013 (bad input params) to invalid", () => {
  expect(
    classifyMinimaxError(200, { base_resp: { status_code: 2013, status_msg: "invalid params" } }),
  ).toBe("invalid")
})

test("minimax poll maps usage on succeeded tasks", async () => {
  const mock = mockFetch([
    () =>
      jsonResponse(200, {
        task: {
          status: "succeeded",
          content: { url: "https://cdn.test/v.mp4" },
          usage: { total_seconds: 5, output_seconds: 5 },
        },
      }),
  ])
  const minimax = createMiniMaxProvider(settings)

  const status = await minimax.videoGenerate.poll({ providerId: "minimax", id: "t" })
  expect(status).toMatchObject({
    state: "done",
    usage: { native: { total_seconds: 5, output_seconds: 5 } },
  })
  mock.restore()
})

test("minimax cancel issues DELETE to v2 task endpoint", async () => {
  const mock = mockFetch([() => jsonResponse(200, { action: "deleted", status: "deleted" })])
  const minimax = createMiniMaxProvider(settings)

  await minimax.videoGenerate.cancel?.({ providerId: "minimax", id: "t-42" })

  const rec = at(mock.recorded, 0)
  expect(rec.url).toBe("https://api.minimaxi.com/v2/video_generation/t-42")
  expect(rec.init?.method).toBe("DELETE")
  mock.restore()
})

test("minimax cancel rejects foreign provider handles", async () => {
  const minimax = createMiniMaxProvider(settings)
  await expect(
    minimax.videoGenerate.cancel?.({ providerId: "ark", id: "t" }),
  ).rejects.toMatchObject({ category: "invalid" })
})

test("minimax submit rejects duration outside 4-15", async () => {
  const minimax = createMiniMaxProvider(settings)
  await expect(
    minimax.videoGenerate.submit({
      model: "MiniMax-H3",
      prompt: "x",
      options: { resolution: "2K", duration: 30 },
    }),
  ).rejects.toMatchObject({ category: "invalid", message: expect.stringContaining("4-15") })
})

test("classifyMinimaxError prefers trailing embedded code over regex (TokenPlan case)", () => {
  // 真实线上返回:HTTP 400 + OpenAI 风格体,码内嵌在消息尾部。
  // 旧逻辑把消息里的 "TokenPlan" 误匹配 /token/ → auth;新逻辑取 (2013) → invalid
  expect(
    classifyMinimaxError(400, {
      type: "error",
      error: {
        type: "bad_request_error",
        message: "invalid params, TokenPlan 或 Credit 暂不支持 MiniMax-H3 系列模型 (2013)",
      },
    }),
  ).toBe("invalid")
})

test("minimax v1 t2v submit posts /v1/video_generation", async () => {
  const mock = mockFetch([
    () => jsonResponse(200, { task_id: "v1-t2v", base_resp: { status_code: 0 } }),
  ])
  const minimax = createMiniMaxProvider(settings)

  const handle = await minimax.videoGenerate.submit({
    model: "MiniMax-Hailuo-2.3",
    prompt: "a cat walks",
    options: { duration: 10, resolution: "768P", prompt_optimizer: false },
  })

  expect(handle).toEqual({ providerId: "minimax", id: "v1-t2v", apiVersion: "v1" })
  const rec = at(mock.recorded, 0)
  expect(rec.url).toBe("https://api.minimaxi.com/v1/video_generation")
  expect(bodyOf(rec)).toEqual({
    model: "MiniMax-Hailuo-2.3",
    prompt: "a cat walks",
    duration: 10,
    resolution: "768P",
    prompt_optimizer: false,
  })
  mock.restore()
})

test("minimax v1 i2v submit sends first_frame_image", async () => {
  const mock = mockFetch([
    () => jsonResponse(200, { task_id: "v1-i2v", base_resp: { status_code: 0 } }),
  ])
  const minimax = createMiniMaxProvider(settings)

  const handle = await minimax.videoGenerate.submit({
    model: "MiniMax-Hailuo-2.3-Fast",
    prompt: "make it move",
    firstFrame: { url: "https://x.test/first.png" },
    options: { duration: 6, resolution: "1080P" },
  })

  expect(handle).toEqual({ providerId: "minimax", id: "v1-i2v", apiVersion: "v1" })
  expect(bodyOf(at(mock.recorded, 0))).toEqual({
    model: "MiniMax-Hailuo-2.3-Fast",
    prompt: "make it move",
    first_frame_image: "https://x.test/first.png",
    duration: 6,
    resolution: "1080P",
  })
  mock.restore()
})

test("minimax v1 fl2v submit sends first and last frame images", async () => {
  const mock = mockFetch([
    () => jsonResponse(200, { task_id: "v1-fl2v", base_resp: { status_code: 0 } }),
  ])
  const minimax = createMiniMaxProvider(settings)

  await minimax.videoGenerate.submit({
    model: "MiniMax-Hailuo-02",
    prompt: "grow up",
    firstFrame: { url: "https://x.test/first.png" },
    lastFrame: { url: "https://x.test/last.png" },
  })

  expect(bodyOf(at(mock.recorded, 0))).toEqual({
    model: "MiniMax-Hailuo-02",
    prompt: "grow up",
    first_frame_image: "https://x.test/first.png",
    last_frame_image: "https://x.test/last.png",
  })
  mock.restore()
})

test("minimax v1 s2v submit sends subject_reference", async () => {
  const mock = mockFetch([
    () => jsonResponse(200, { task_id: "v1-s2v", base_resp: { status_code: 0 } }),
  ])
  const minimax = createMiniMaxProvider(settings)

  await minimax.videoGenerate.submit({
    model: "S2V-01",
    prompt: "a girl waves",
    options: {
      subject_reference: [{ type: "character", image: ["https://x.test/subject.png"] }],
    },
  })

  expect(bodyOf(at(mock.recorded, 0))).toEqual({
    model: "S2V-01",
    prompt: "a girl waves",
    subject_reference: [{ type: "character", image: ["https://x.test/subject.png"] }],
  })
  mock.restore()
})

test("minimax v1 poll resolves file_id through files/retrieve", async () => {
  const mock = mockFetch([
    () => jsonResponse(200, { task_id: "t", status: "Queueing", base_resp: { status_code: 0 } }),
    () => jsonResponse(200, { task_id: "t", status: "Processing", base_resp: { status_code: 0 } }),
    () =>
      jsonResponse(200, {
        task_id: "t",
        status: "Success",
        file_id: "file-9",
        base_resp: { status_code: 0 },
      }),
    () =>
      jsonResponse(200, {
        file: { download_url: "https://cdn.test/v1.mp4" },
        base_resp: { status_code: 0 },
      }),
  ])
  const minimax = createMiniMaxProvider(settings)
  const handle = { providerId: "minimax", id: "t", apiVersion: "v1" } as const

  expect(await minimax.videoGenerate.poll(handle)).toEqual({ state: "pending" })
  expect(await minimax.videoGenerate.poll(handle)).toEqual({ state: "running" })
  expect(await minimax.videoGenerate.poll(handle)).toEqual({
    state: "done",
    artifacts: [{ url: "https://cdn.test/v1.mp4", mimeType: "video/mp4" }],
  })
  expect(at(mock.recorded, 0).url).toBe(
    "https://api.minimaxi.com/v1/query/video_generation?task_id=t",
  )
  expect(at(mock.recorded, 3).url).toBe("https://api.minimaxi.com/v1/files/retrieve?file_id=file-9")
  mock.restore()
})

test("minimax v1 submit rejects incompatible model/mode combinations", async () => {
  const minimax = createMiniMaxProvider(settings)
  await expect(
    minimax.videoGenerate.submit({ model: "T2V-01", prompt: "x", firstFrame: { url: "u" } }),
  ).rejects.toMatchObject({ category: "invalid", message: /image-to-video/ })
  await expect(
    minimax.videoGenerate.submit({ model: "I2V-01", prompt: "x" }),
  ).rejects.toMatchObject({ category: "invalid", message: /text-to-video/ })
  await expect(
    minimax.videoGenerate.submit({ model: "S2V-01", prompt: "x" }),
  ).rejects.toMatchObject({ category: "invalid", message: /subject_reference/ })
})

test("minimax v1 create base_resp error is classified", async () => {
  const mock = mockFetch([
    () => jsonResponse(200, { base_resp: { status_code: 1004, status_msg: "bad key" } }),
  ])
  const minimax = createMiniMaxProvider(settings)
  await expect(
    minimax.videoGenerate.submit({ model: "T2V-01", prompt: "x" }),
  ).rejects.toMatchObject({ category: "auth" })
  mock.restore()
})

test("minimax v1 cancel is unsupported and stripped handles poll v2", async () => {
  const submitMock = mockFetch([
    () => jsonResponse(200, { task_id: "t-stripped", base_resp: { status_code: 0 } }),
    () =>
      jsonResponse(200, {
        task: { id: "t-stripped", status: "queued" },
      }),
  ])
  const minimax = createMiniMaxProvider(settings)

  const handle = await minimax.videoGenerate.submit({ model: "T2V-01", prompt: "x" })
  await expect(
    minimax.videoGenerate.cancel?.({ providerId: "minimax", id: handle.id, apiVersion: "v1" }),
  ).rejects.toMatchObject({ category: "invalid", message: /no cancel endpoint/ })

  // Callers that strip apiVersion lose v1 routing; handles carry it for exactly this.
  const stripped = { providerId: "minimax", id: handle.id }
  expect(await minimax.videoGenerate.poll(stripped)).toEqual({ state: "pending" })
  expect(at(submitMock.recorded, 1).url).toBe(
    "https://api.minimaxi.com/v2/query/video_generation/t-stripped",
  )
  submitMock.restore()
})

test("minimax models list includes the six documented v1 endpoint families", () => {
  const ids = new Set(MINIMAX_MODELS.map((model) => model.id))
  for (const id of [
    "MiniMax-Hailuo-2.3",
    "MiniMax-Hailuo-2.3-Fast",
    "MiniMax-Hailuo-02",
    "T2V-01-Director",
    "T2V-01",
    "I2V-01-Director",
    "I2V-01-live",
    "I2V-01",
    "S2V-01",
  ]) {
    expect(ids.has(id)).toBe(true)
  }
  expect(MINIMAX_VIDEO_MODEL_MODES["MiniMax-Hailuo-02"]).toEqual(["t2v", "i2v", "fl2v"])
  expect(MINIMAX_VIDEO_MODEL_MODES["S2V-01"]).toEqual(["s2v"])
})

test("custom model declarations: v1 mode routes to the v1 endpoint", async () => {
  const mock = mockFetch([() => jsonResponse(200, { task_id: "custom-1" })])
  const minimax = createMiniMaxProvider({
    apiKey: "mm-key",
    models: [
      {
        id: "MiniMax-H4",
        mode: "i2v",
        capabilities: { "video.generate": { textOnly: false, firstFrame: true } },
        note: "new model on the v1 protocol",
      },
    ],
  })

  const h4 = minimax.models.find((m) => m.id === "MiniMax-H4")
  expect(h4?.source).toBe("custom")
  expect(h4?.note).toBe("new model on the v1 protocol")

  const handle = await minimax.videoGenerate.submit({
    model: "MiniMax-H4",
    prompt: "a crane",
    firstFrame: { url: "https://x.test/f.png" },
    options: { duration: 6, resolution: "768P" },
  })
  expect(handle).toEqual({ providerId: "minimax", id: "custom-1", apiVersion: "v1" })
  expect(at(mock.recorded, 0).url).toBe("https://api.minimaxi.com/v1/video_generation")
  expect(bodyOf(at(mock.recorded, 0))["model"]).toBe("MiniMax-H4")
  mock.restore()
})

test("custom model declaration errors: missing mode and unknown mode", () => {
  expect(() =>
    createMiniMaxProvider({
      apiKey: "mm-key",
      models: [{ id: "MiniMax-H4", capabilities: { "video.generate": {} } }],
    }),
  ).toThrow(/MiniMax-H4.*'mode' is required/)
  expect(() =>
    createMiniMaxProvider({ apiKey: "mm-key", models: [{ id: "MiniMax-H4", mode: "v3" }] }),
  ).toThrow(/unknown mode 'v3'/)
})

test("override retargets a builtin model's protocol mode", async () => {
  const mock = mockFetch([() => jsonResponse(200, { task_id: "t2" })])
  const minimax = createMiniMaxProvider({
    apiKey: "mm-key",
    models: [{ id: "MiniMax-H3", mode: "t2v" }],
  })
  await minimax.videoGenerate.submit({
    model: "MiniMax-H3",
    prompt: "x",
    options: { resolution: "768P", duration: 6 },
  })
  // t2v is a v1 mode → v1 endpoint, not /v2
  expect(at(mock.recorded, 0).url).toBe("https://api.minimaxi.com/v1/video_generation")
  mock.restore()
})

test("minimax text chat posts to /v1/chat/completions", async () => {
  const mock = mockFetch([
    () =>
      jsonResponse(200, {
        choices: [{ message: { content: "hello there" } }],
        usage: { total_tokens: 10, prompt_tokens: 5, completion_tokens: 5 },
        base_resp: { status_code: 0 },
      }),
  ])
  const minimax = createMiniMaxProvider(settings)

  const result = await minimax.textGenerate.create({
    model: "MiniMax-M2.7",
    prompt: "hi",
    system: "be brief",
    options: { temperature: 0.5 },
  })

  expect(result.text).toBe("hello there")
  expect(result.usage).toEqual({
    native: { total_tokens: 10, prompt_tokens: 5, completion_tokens: 5 },
  })
  const rec = at(mock.recorded, 0)
  expect(rec.url).toBe("https://api.minimaxi.com/v1/chat/completions")
  expect(headersOf(rec)["authorization"]).toBe("Bearer mm-key")
  expect(bodyOf(rec)).toEqual({
    model: "MiniMax-M2.7",
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ],
    temperature: 0.5,
  })
  mock.restore()
})

test("minimax text chat strips only a leading closed <think> block", async () => {
  const mock = mockFetch([
    () =>
      jsonResponse(200, {
        choices: [{ message: { content: "<think>reasoning…</think>\nanswer body" } }],
        base_resp: { status_code: 0 },
      }),
    () =>
      jsonResponse(200, {
        choices: [{ message: { content: "<think>unterminated" } }],
        base_resp: { status_code: 0 },
      }),
    () =>
      jsonResponse(200, {
        choices: [{ message: { content: "use <think> literally" } }],
        base_resp: { status_code: 0 },
      }),
  ])
  const minimax = createMiniMaxProvider(settings)

  const stripped = await minimax.textGenerate.create({ model: "MiniMax-M2.7", prompt: "x" })
  expect(stripped.text).toBe("answer body")
  const unterminated = await minimax.textGenerate.create({ model: "MiniMax-M2.7", prompt: "x" })
  expect(unterminated.text).toBe("<think>unterminated")
  const inline = await minimax.textGenerate.create({ model: "MiniMax-M2.7", prompt: "x" })
  expect(inline.text).toBe("use <think> literally")
  mock.restore()
})

test("minimax text chat surfaces base_resp errors", async () => {
  const mock = mockFetch([
    () => jsonResponse(200, { base_resp: { status_code: 1004, status_msg: "invalid api key" } }),
  ])
  const minimax = createMiniMaxProvider(settings)
  await expect(
    minimax.textGenerate.create({ model: "MiniMax-M2.7", prompt: "x" }),
  ).rejects.toMatchObject({ category: "auth" })
  mock.restore()
})

test("minimax registers the documented chat models with a text default", () => {
  const ids = new Set(MINIMAX_MODELS.map((model) => model.id))
  for (const id of [
    "MiniMax-M3",
    "MiniMax-M2.7",
    "MiniMax-M2.7-highspeed",
    "MiniMax-M2.5",
    "MiniMax-M2.5-highspeed",
    "MiniMax-M2.1",
    "MiniMax-M2.1-highspeed",
    "MiniMax-M2",
  ]) {
    expect(ids.has(id)).toBe(true)
  }
  expect(MINIMAX_DEFAULT_MODELS["text.generate"]).toBe("MiniMax-M2.7")

  const minimax = createMiniMaxProvider(settings)
  expect(minimax.defaultModels?.["text.generate"]).toBe("MiniMax-M2.7")
  expect(
    minimax.models.find((m) => m.id === "MiniMax-M2.7")?.capabilities["text.generate"],
  ).toEqual({})
})
