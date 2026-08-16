import { createHmac } from "node:crypto"
import { test } from "vitest"
import { createKlingProvider } from "../kling"
import { classifyKlingError } from "../kling/error-map"
import { decodeKlingJwtClaims, signKlingJwt } from "../kling/jwt"
import { at, bodyOf, headersOf, jsonResponse, mockFetch } from "./helpers"

function base64urlDecodeToString(part: string): string {
  const padded = part.replace(/-/g, "+").replace(/_/g, "/")
  return Buffer.from(padded, "base64").toString("utf8")
}

// jwt

test("kling jwt header and signature verify against node crypto", () => {
  const token = signKlingJwt("ak-123", "sk-456", 1_700_000_000)
  const [header = "", payload = "", signature = ""] = token.split(".")

  expect(JSON.parse(base64urlDecodeToString(header))).toEqual({ alg: "HS256", typ: "JWT" })
  expect(decodeKlingJwtClaims(token)).toEqual({
    iss: "ak-123",
    exp: 1_700_001_800,
    nbf: 1_699_999_995,
  })

  const expected = createHmac("sha256", "sk-456")
    .update(`${header}.${payload}`)
    .digest()
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
  expect(signature).toBe(expected)
})

test("kling jwt uses provided ttl", () => {
  const claims = decodeKlingJwtClaims(signKlingJwt("ak", "sk", 1000, 60))
  expect(claims.exp).toBe(1060)
})

// provider

test("kling text-to-video submit builds contents/settings/options shape", async () => {
  const mock = mockFetch([() => jsonResponse(200, { code: 0, data: { id: "internal-1" } })])
  const kling = createKlingProvider({ apiKey: "new-key" })

  const handle = await kling.videoGenerate.submit({
    model: "kling-3.0-turbo",
    prompt: "a dragon",
    options: { duration: 10, aspectRatio: "16:9", resolution: "1080p", watermark: false },
  })

  expect(handle.providerId).toBe("kling")
  const first = at(mock.recorded, 0)
  expect(first.url).toBe("https://api-beijing.klingai.com/text-to-video/kling-3.0-turbo")
  expect(headersOf(first)["authorization"]).toBe("Bearer new-key")
  const body = bodyOf(first)
  expect(body["contents"]).toEqual([{ type: "prompt", text: "a dragon" }])
  expect(body["settings"]).toEqual({ duration: 10, aspect_ratio: "16:9", resolution: "1080p" })
  expect(body["options"]).toEqual({
    external_task_id: handle.id,
    watermark_info: { enabled: false },
  })
  mock.restore()
})

test("kling image-to-video uses contents first_frame with raw base64", async () => {
  const mock = mockFetch([() => jsonResponse(200, { code: 0, data: {} })])
  const kling = createKlingProvider({ apiKey: "k" })

  await kling.videoGenerate.submit({
    model: "kling-3.0-turbo",
    prompt: "go",
    firstFrame: { base64: "aGVsbG8=" },
  })

  const first = at(mock.recorded, 0)
  expect(first.url).toContain("/image-to-video/kling-3.0-turbo")
  expect(bodyOf(first)["contents"]).toEqual([
    { type: "prompt", text: "go" },
    { type: "first_frame", url: "aGVsbG8=" },
  ])
  mock.restore()
})

test("kling rejects last frame: new API has no tail input", async () => {
  const kling = createKlingProvider({ apiKey: "k" })
  await expect(
    kling.videoGenerate.submit({
      model: "kling-3.0-turbo",
      prompt: "x",
      lastFrame: { url: "https://x.test/b.png" },
    }),
  ).rejects.toMatchObject({ category: "invalid" })
})

test("kling poll reads task array and maps outputs", async () => {
  const mock = mockFetch([
    () => jsonResponse(200, { code: 0, data: [{ status: "processing" }] }),
    () =>
      jsonResponse(200, {
        code: 0,
        data: [
          {
            status: "succeeded",
            outputs: [
              { type: "video", url: "https://cdn.test/v.mp4", watermark_url: "https://wm" },
            ],
          },
        ],
      }),
  ])
  const kling = createKlingProvider({ apiKey: "k" })
  const handle = { providerId: "kling", id: "ext-1" }

  expect(await kling.videoGenerate.poll(handle)).toEqual({ state: "running" })
  const done = await kling.videoGenerate.poll(handle)
  expect(done.state).toBe("done")
  if (done.state === "done") {
    expect(done.artifacts[0]).toMatchObject({
      url: "https://cdn.test/v.mp4",
      watermark: true,
      mimeType: "video/mp4",
    })
  }
  expect(at(mock.recorded, 0).url).toContain("/tasks?external_task_ids=ext-1")
  mock.restore()
})

test("kling envelope error code throws with raw", async () => {
  const mock = mockFetch([
    () => jsonResponse(200, { code: 1205, message: "content moderation failed" }),
  ])
  const kling = createKlingProvider({ apiKey: "k" })

  await expect(
    kling.videoGenerate.submit({ model: "kling-3.0-turbo", prompt: "x" }),
  ).rejects.toMatchObject({ message: "content moderation failed" })
  mock.restore()
})

test("kling envelope business errors are classified, not blanket internal", async () => {
  const mock = mockFetch([
    () => jsonResponse(200, { code: 4011, message: "insufficient balance" }),
    () => jsonResponse(200, { code: 4011, message: "rate limit exceeded, too many request" }),
  ])
  const kling = createKlingProvider({ apiKey: "k" })

  await expect(
    kling.videoGenerate.submit({ model: "kling-3.0-turbo", prompt: "x" }),
  ).rejects.toMatchObject({ category: "quota" })
  await expect(
    kling.videoGenerate.submit({ model: "kling-3.0-turbo", prompt: "x" }),
  ).rejects.toMatchObject({ category: "rate" })
  mock.restore()
})

test("kling image create surfaces envelope errors immediately instead of polling 300s", async () => {
  // HTTP 200 + code != 0:提交即失败(余额不足),不应进入轮询
  const mock = mockFetch([() => jsonResponse(200, { code: 4011, message: "insufficient balance" })])
  const kling = createKlingProvider({ apiKey: "k", pollIntervalMs: 1 })

  await expect(
    kling.imageGenerate.create({ model: "kolors", prompt: "a cat" }),
  ).rejects.toMatchObject({ category: "quota", message: "insufficient balance" })
  expect(mock.recorded.length).toBe(1) // submit only, no poll calls
  mock.restore()
})

test("kling image create timeout error carries the task id for manual recovery", async () => {
  // 提交成功但永不完成:用 0 超时立即触发超时分支
  const mock = mockFetch([() => jsonResponse(200, { code: 0, data: {} })])
  const kling = createKlingProvider({ apiKey: "k", pollTimeoutMs: 0 })

  await expect(
    kling.imageGenerate.create({ model: "kolors", prompt: "a cat" }),
  ).rejects.toMatchObject({
    category: "internal",
    raw: expect.objectContaining({ taskId: expect.any(String) }),
  })
  mock.restore()
})

test("kling image create respects an aborted signal", async () => {
  const mock = mockFetch([() => jsonResponse(200, { code: 0, data: {} })])
  const kling = createKlingProvider({ apiKey: "k", pollIntervalMs: 1 })
  const controller = new AbortController()
  controller.abort()

  await expect(
    kling.imageGenerate.create({ model: "kolors", prompt: "a cat" }, { signal: controller.signal }),
  ).rejects.toThrow(/polling aborted/)
  expect(mock.recorded.length).toBe(1) // submit happened, polling stopped before first poll
  mock.restore()
})

test("kling image create submits to legacy endpoint and polls by id", async () => {
  const mock = mockFetch([
    () => jsonResponse(200, { code: 0, data: {} }),
    () => jsonResponse(200, { code: 0, data: { task_id: "i-1", task_status: "processing" } }),
    () =>
      jsonResponse(200, {
        code: 0,
        data: {
          task_id: "i-1",
          task_status: "succeed",
          task_result: { images: [{ index: 0, url: "https://cdn.test/i.png" }] },
        },
      }),
  ])
  const kling = createKlingProvider({ apiKey: "k", pollIntervalMs: 1 })

  const result = await kling.imageGenerate.create({ model: "kolors", prompt: "a cat" })

  expect(at(mock.recorded, 0).url).toBe("https://api-beijing.klingai.com/v1/images/generations")
  expect(bodyOf(at(mock.recorded, 0))["model_name"]).toBe("kolors")
  expect(at(mock.recorded, 1).url).toMatch(/\/v1\/images\/generations\/[0-9a-f-]+$/)
  expect(result.artifacts).toEqual([{ url: "https://cdn.test/i.png", mimeType: "image/png" }])
  mock.restore()
})

test("kling jwt auth used when no api key", async () => {
  const mock = mockFetch([() => jsonResponse(200, { code: 0, data: {} })])
  const kling = createKlingProvider({ accessKey: "ak", secretKey: "sk" })

  await kling.videoGenerate.submit({ model: "kling-3.0-turbo", prompt: "x" })
  const auth = headersOf(at(mock.recorded, 0))["authorization"]
  expect(auth).toMatch(/^Bearer eyJ/)
  if (auth) {
    const claims = decodeKlingJwtClaims(auth.slice(7))
    expect(claims.iss).toBe("ak")
  }
  mock.restore()
})

test("kling missing credentials throws auth", () => {
  expect(() => createKlingProvider({}, {})).toThrow("missing Kling credentials")
})

test("classifyKlingError maps messages", () => {
  expect(classifyKlingError(403, undefined)).toBe("auth")
  expect(classifyKlingError(400, { error: { message: "content moderation blocked" } })).toBe(
    "moderation",
  )
  expect(classifyKlingError(400, { message: "rate limit exceeded" })).toBe("rate")
  expect(classifyKlingError(400, { message: "unknown thing" })).toBeUndefined()
})

test("kling poll rejects a foreign provider handle", async () => {
  const kling = createKlingProvider({ apiKey: "k" })
  await expect(kling.videoGenerate.poll({ providerId: "ark", id: "t" })).rejects.toMatchObject({
    category: "invalid",
  })
})
