import { test } from "vitest"
import { classifyZhipuError } from "../zhipu/error-map"
import { createZhipuProvider } from "../zhipu/index"
import { ZHIPU_MODELS } from "../zhipu/models"
import { at, bodyOf, headersOf, jsonResponse, mockFetch } from "./helpers"

const settings = { apiKey: "test-key" }

// video submit

test("zhipu text-to-video posts to /videos/generations with passthrough options", async () => {
  const mock = mockFetch([() => jsonResponse(200, { id: "t-1", task_status: "PROCESSING" })])
  const zhipu = createZhipuProvider(settings)

  const handle = await zhipu.videoGenerate.submit({
    model: "cogvideox-3",
    prompt: "a cat playing",
    options: { size: "1920x1080", fps: 60, duration: 10, with_audio: true, quality: "quality" },
  })

  expect(handle).toEqual({ providerId: "zhipu", id: "t-1" })
  const first = at(mock.recorded, 0)
  expect(first.url).toBe("https://open.bigmodel.cn/api/paas/v4/videos/generations")
  expect(headersOf(first)["authorization"]).toBe("Bearer test-key")
  expect(bodyOf(first)).toEqual({
    model: "cogvideox-3",
    prompt: "a cat playing",
    size: "1920x1080",
    fps: 60,
    duration: 10,
    with_audio: true,
    quality: "quality",
  })
  mock.restore()
})

test("zhipu cogvideox-3 firstFrame maps to single image_url", async () => {
  const mock = mockFetch([() => jsonResponse(200, { id: "t-2" })])
  const zhipu = createZhipuProvider(settings)

  await zhipu.videoGenerate.submit({
    model: "cogvideox-3",
    prompt: "go",
    firstFrame: { base64: "AAA=" },
  })

  const body = bodyOf(at(mock.recorded, 0))
  expect(body["image_url"]).toBe("data:image/png;base64,AAA=")
  mock.restore()
})

test("zhipu cogvideox-3 first+last frames map to [first, last] array", async () => {
  const mock = mockFetch([() => jsonResponse(200, { id: "t-3" })])
  const zhipu = createZhipuProvider(settings)

  await zhipu.videoGenerate.submit({
    model: "cogvideox-3",
    prompt: "go",
    firstFrame: { url: "https://x.test/first.png" },
    lastFrame: { url: "https://x.test/last.png" },
  })

  expect(bodyOf(at(mock.recorded, 0))["image_url"]).toEqual([
    "https://x.test/first.png",
    "https://x.test/last.png",
  ])
  mock.restore()
})

test("zhipu cogvideox-2 rejects lastFrame but accepts single firstFrame", async () => {
  const zhipu = createZhipuProvider(settings)
  await expect(
    zhipu.videoGenerate.submit({
      model: "cogvideox-2",
      prompt: "x",
      firstFrame: { url: "https://x.test/a.png" },
      lastFrame: { url: "https://x.test/b.png" },
    }),
  ).rejects.toMatchObject({ category: "invalid" })

  const mock = mockFetch([() => jsonResponse(200, { id: "t-4" })])
  await zhipu.videoGenerate.submit({
    model: "cogvideox-flash",
    prompt: "x",
    firstFrame: { url: "https://x.test/a.png" },
  })
  expect(bodyOf(at(mock.recorded, 0))["image_url"]).toBe("https://x.test/a.png")
  mock.restore()
})

test("zhipu viduq1-text rejects image input", async () => {
  const zhipu = createZhipuProvider(settings)
  await expect(
    zhipu.videoGenerate.submit({
      model: "viduq1-text",
      prompt: "x",
      firstFrame: { url: "https://x.test/a.png" },
    }),
  ).rejects.toMatchObject({ category: "invalid" })
})

test("zhipu vidu start-end models build [first, last] image arrays", async () => {
  const mock = mockFetch([() => jsonResponse(200, { id: "t-5" })])
  const zhipu = createZhipuProvider(settings)

  await zhipu.videoGenerate.submit({
    model: "vidu2-start-end",
    prompt: "x",
    firstFrame: { url: "https://x.test/first.webp" },
    lastFrame: { base64: "QQ==" },
    options: { duration: 4, size: "1280x720", movement_amplitude: "small" },
  })

  const body = bodyOf(at(mock.recorded, 0))
  expect(body["image_url"]).toEqual(["https://x.test/first.webp", "data:image/png;base64,QQ=="])
  expect(body["duration"]).toBe(4)
  mock.restore()
})

test("zhipu vidu2-reference wraps firstFrame as 1-element array; multi-image passthrough", async () => {
  const mock = mockFetch([() => jsonResponse(200, { id: "t-6" })])
  const zhipu = createZhipuProvider(settings)

  await zhipu.videoGenerate.submit({
    model: "vidu2-reference",
    prompt: "x",
    firstFrame: { url: "https://x.test/ref1.png" },
  })
  expect(bodyOf(at(mock.recorded, 0))["image_url"]).toEqual(["https://x.test/ref1.png"])

  await zhipu.videoGenerate.submit({
    model: "vidu2-reference",
    prompt: "x",
    options: {
      image_url: ["https://x.test/r1.png", "https://x.test/r2.png", "https://x.test/r3.png"],
      aspect_ratio: "9:16",
    },
  })
  const second = bodyOf(at(mock.recorded, 1))
  expect(second["image_url"]).toHaveLength(3)
  expect(second["aspect_ratio"]).toBe("9:16")
  mock.restore()
})

test("zhipu lastFrame without firstFrame is invalid for every model", async () => {
  const zhipu = createZhipuProvider(settings)
  await expect(
    zhipu.videoGenerate.submit({
      model: "viduq1-start-end",
      prompt: "x",
      lastFrame: { url: "https://x.test/b.png" },
    }),
  ).rejects.toMatchObject({ category: "invalid" })
})

test("zhipu unknown model ids fall through with generic image mapping", async () => {
  const mock = mockFetch([() => jsonResponse(200, { id: "t-7" })])
  const zhipu = createZhipuProvider(settings)

  await zhipu.videoGenerate.submit({
    model: "cogvideox-4",
    prompt: "x",
    firstFrame: { url: "https://x.test/a.png" },
    lastFrame: { url: "https://x.test/b.png" },
  })
  expect(bodyOf(at(mock.recorded, 0))["image_url"]).toEqual([
    "https://x.test/a.png",
    "https://x.test/b.png",
  ])
  mock.restore()
})

// video poll

test("zhipu video poll maps async-result states", async () => {
  const responses = [
    () => jsonResponse(200, { task_status: "PROCESSING", model: "cogvideox-3", request_id: "r" }),
    () =>
      jsonResponse(200, {
        task_status: "SUCCESS",
        model: "cogvideox-3",
        video_result: [
          { url: "https://cdn.test/v.mp4", cover_image_url: "https://cdn.test/cover.jpg" },
        ],
      }),
  ]
  const mock = mockFetch(responses)
  const zhipu = createZhipuProvider(settings)
  const handle = { providerId: "zhipu", id: "t-1" }

  expect(await zhipu.videoGenerate.poll(handle)).toEqual({ state: "running" })
  expect(await zhipu.videoGenerate.poll(handle)).toEqual({
    state: "done",
    artifacts: [{ url: "https://cdn.test/v.mp4", mimeType: "video/mp4" }],
  })
  expect(at(mock.recorded, 0).url).toBe("https://open.bigmodel.cn/api/paas/v4/async-result/t-1")
  mock.restore()
})

test("zhipu video poll FAIL maps to failed, content_filter to moderation", async () => {
  const mock = mockFetch([
    () => jsonResponse(200, { task_status: "FAIL", model: "cogvideox-3" }),
    () =>
      jsonResponse(200, {
        task_status: "FAIL",
        content_filter: [{ role: "assistant", level: 0 }],
      }),
  ])
  const zhipu = createZhipuProvider(settings)
  const handle = { providerId: "zhipu", id: "t-1" }

  const failed = await zhipu.videoGenerate.poll(handle)
  expect(failed).toMatchObject({ state: "failed", error: { category: "internal" } })
  const moderated = await zhipu.videoGenerate.poll(handle)
  expect(moderated).toMatchObject({ state: "failed", error: { category: "moderation" } })
  mock.restore()
})

test("zhipu poll rejects a foreign provider handle", async () => {
  const zhipu = createZhipuProvider(settings)
  await expect(zhipu.videoGenerate.poll({ providerId: "ark", id: "t" })).rejects.toMatchObject({
    category: "invalid",
  })
})

// image generate

test("zhipu sync image create posts to /images/generations and maps urls", async () => {
  const mock = mockFetch([
    () =>
      jsonResponse(200, {
        created: 1_700_000_000,
        data: [{ url: "https://cdn.test/i.jpg?sig=1" }],
      }),
  ])
  const zhipu = createZhipuProvider(settings)

  const result = await zhipu.imageGenerate.create({
    model: "cogview-4",
    prompt: "a cat",
    options: { size: "1024x1024", quality: "standard" },
  })

  expect(at(mock.recorded, 0).url).toBe("https://open.bigmodel.cn/api/paas/v4/images/generations")
  expect(bodyOf(at(mock.recorded, 0))).toEqual({
    model: "cogview-4",
    prompt: "a cat",
    size: "1024x1024",
    quality: "standard",
  })
  expect(result.artifacts).toEqual([
    { url: "https://cdn.test/i.jpg?sig=1", mimeType: "image/jpeg" },
  ])
  mock.restore()
})

test("zhipu async image create submits, polls async-result, and unwraps image_result", async () => {
  const mock = mockFetch([
    () => jsonResponse(200, { id: "img-task", task_status: "PROCESSING" }),
    () => jsonResponse(200, { task_status: "PROCESSING" }),
    () =>
      jsonResponse(200, {
        task_status: "SUCCESS",
        image_result: [{ url: "https://cdn.test/glm.png" }],
      }),
  ])
  const zhipu = createZhipuProvider({ apiKey: "k", pollIntervalMs: 1 })

  const result = await zhipu.imageGenerate.create({
    model: "glm-image",
    prompt: "a cat",
    options: { useAsync: true, size: "1280x1280" },
  })

  expect(at(mock.recorded, 0).url).toBe(
    "https://open.bigmodel.cn/api/paas/v4/async/images/generations",
  )
  expect(bodyOf(at(mock.recorded, 0))).toEqual({
    model: "glm-image",
    prompt: "a cat",
    size: "1280x1280",
  })
  expect(at(mock.recorded, 1).url).toBe(
    "https://open.bigmodel.cn/api/paas/v4/async-result/img-task",
  )
  expect(result.artifacts).toEqual([{ url: "https://cdn.test/glm.png", mimeType: "image/png" }])
  mock.restore()
})

test("zhipu async image rejects non-glm-image models and surfaces task failure", async () => {
  const zhipu = createZhipuProvider(settings)
  await expect(
    zhipu.imageGenerate.create({ model: "cogview-4", prompt: "x", options: { useAsync: true } }),
  ).rejects.toMatchObject({ category: "invalid" })

  const mock = mockFetch([
    () => jsonResponse(200, { id: "img-task", task_status: "PROCESSING" }),
    () => jsonResponse(200, { task_status: "FAIL", content_filter: [{ role: "user", level: 1 }] }),
  ])
  await expect(
    zhipu.imageGenerate.create({
      model: "glm-image",
      prompt: "x",
      options: { useAsync: true },
    }),
  ).rejects.toMatchObject({ category: "moderation" })
  mock.restore()
})

test("zhipu sync image with empty data fails loudly", async () => {
  const mock = mockFetch([() => jsonResponse(200, { created: 1, data: [] })])
  const zhipu = createZhipuProvider(settings)
  await expect(
    zhipu.imageGenerate.create({ model: "cogview-4", prompt: "x" }),
  ).rejects.toMatchObject({ category: "internal" })
  mock.restore()
})

test("zhipu async image timeout error carries the task id (recoverable via videoGenerate.poll)", async () => {
  // 提交成功但 pollTimeoutMs=0 立即触发超时分支;raw 里的 taskId 可续查
  const mock = mockFetch([() => jsonResponse(200, { id: "img-task", task_status: "PROCESSING" })])
  const zhipu = createZhipuProvider({ apiKey: "k", pollTimeoutMs: 0 })

  await expect(
    zhipu.imageGenerate.create({ model: "glm-image", prompt: "x", options: { useAsync: true } }),
  ).rejects.toMatchObject({
    category: "internal",
    raw: { taskId: "img-task" },
  })
  mock.restore()
})

// auth + errors

test("zhipu missing api key throws auth", () => {
  expect(() => createZhipuProvider({}, {})).toThrow("missing Zhipu API key")
})

test("zhipu env fallback ZHIPU_API_KEY then BIGMODEL_API_KEY", async () => {
  const mock = mockFetch([() => jsonResponse(200, { id: "t" })])
  const zhipu = createZhipuProvider({}, { BIGMODEL_API_KEY: "bm-key" })
  await zhipu.videoGenerate.submit({ model: "cogvideox-3", prompt: "x" })
  expect(headersOf(at(mock.recorded, 0))["authorization"]).toBe("Bearer bm-key")
  mock.restore()
})

test("zhipu error envelope is classified by business code", async () => {
  const mock = mockFetch([
    () => jsonResponse(401, { error: { code: "1001", message: "no auth header" } }),
  ])
  const zhipu = createZhipuProvider(settings)
  await expect(
    zhipu.videoGenerate.submit({ model: "cogvideox-3", prompt: "x" }),
  ).rejects.toMatchObject({ category: "auth", message: "no auth header" })
  mock.restore()
})

test("classifyZhipuError maps business codes and http fallbacks", () => {
  expect(classifyZhipuError(400, { error: { code: "1211", message: "模型不存在" } })).toBe(
    "invalid",
  )
  expect(classifyZhipuError(400, { error: { code: "1214", message: "参数非法" } })).toBe("invalid")
  expect(classifyZhipuError(400, { error: { code: "1301", message: "敏感内容" } })).toBe(
    "moderation",
  )
  expect(classifyZhipuError(429, { error: { code: "1113", message: "欠费" } })).toBe("quota")
  expect(classifyZhipuError(429, { error: { code: "1302", message: "速率限制" } })).toBe("rate")
  expect(classifyZhipuError(429, { error: { code: "1316", message: "5 小时上限" } })).toBe("rate")
  expect(classifyZhipuError(401, { error: { code: "1003", message: "token 过期" } })).toBe("auth")
  expect(classifyZhipuError(500, undefined)).toBe("internal")
  expect(classifyZhipuError(403, undefined)).toBe("auth")
  // 无业务码时按消息兜底
  expect(classifyZhipuError(400, { error: { message: "输入包含敏感内容" } })).toBe("moderation")
  expect(classifyZhipuError(200, { error: { code: "9999", message: "whatever" } })).toBeUndefined()
})

// model catalog sanity

test("zhipu models cover documented text, video and image ids", () => {
  const ids = ZHIPU_MODELS.map((m) => m.id)
  expect(ids).toEqual([
    "glm-4-flash",
    "glm-4.5-air",
    "glm-4.6",
    "cogvideox-3",
    "cogvideox-2",
    "cogvideox-flash",
    "viduq1-text",
    "viduq1-image",
    "vidu2-image",
    "viduq1-start-end",
    "vidu2-start-end",
    "vidu2-reference",
    "glm-image",
    "cogview-4-250304",
    "cogview-4",
    "cogview-3-flash",
  ])
})

// text generation

test("zhipu text generate posts chat/completions with system+user messages", async () => {
  const mock = mockFetch([
    () =>
      jsonResponse(200, {
        choices: [{ message: { content: "hi there" } }],
        usage: { total_tokens: 3 },
      }),
  ])
  const zhipu = createZhipuProvider(settings)

  const result = await zhipu.textGenerate.create({
    model: "glm-4-flash",
    prompt: "hello",
    system: "be brief",
    options: { temperature: 0.7 },
  })

  expect(result.text).toBe("hi there")
  const first = at(mock.recorded, 0)
  expect(first.url).toBe("https://open.bigmodel.cn/api/paas/v4/chat/completions")
  expect(headersOf(first)["authorization"]).toBe("Bearer test-key")
  expect(bodyOf(first)).toEqual({
    model: "glm-4-flash",
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: "hello" },
    ],
    temperature: 0.7,
  })
  mock.restore()
})
