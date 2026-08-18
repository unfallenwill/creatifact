import { mkdtemp, open, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "vitest"
import { MAX_INLINE_BYTES, toUrlRef } from "../core/fileref"
import { createJsonClient, defaultClassifyError, requestJson } from "../core/http"
import { JobTimeoutError, pollUntil } from "../core/job"
import { capabilitiesOf, guardHandle, type Provider, ProviderError } from "../core/types"
import { guardFrameSupport } from "../core/validate"
import { at, headersOf, jsonResponse, mockFetch } from "./helpers"

// capabilitiesOf

function fakeProvider(methods: Partial<Provider>): Provider {
  return { id: "fake", models: [], ...methods }
}

test("capabilitiesOf derives capabilities from implemented methods", () => {
  expect(capabilitiesOf(fakeProvider({}))).toEqual([])
  expect(capabilitiesOf(fakeProvider({ videoGenerate: {} as never }))).toEqual(["video.generate"])
  expect(
    capabilitiesOf(fakeProvider({ imageGenerate: {} as never, embed: {} as never })).sort(),
  ).toEqual(["embed", "image.generate"])
})

// guardHandle

test("guardHandle rejects foreign handles and accepts own", () => {
  const handle = { providerId: "ark", id: "t-1" }
  expect(() => guardHandle("kling", handle)).toThrow(/belongs to 'ark'/)
  expect(() => guardHandle("ark", handle)).not.toThrow()
})

// guardFrameSupport

const GUARD_MODELS = [
  {
    id: "m-no-last",
    capabilities: { "video.generate": { firstFrame: true, lastFrame: false } },
    lastVerified: "2026-08",
  },
  {
    id: "m-unverified",
    capabilities: { "video.generate": {} },
    lastVerified: "2026-08",
  },
] as const

test("guardFrameSupport rejects explicit false, passes omitted/unknown/true", () => {
  expect(() =>
    guardFrameSupport([...GUARD_MODELS], {
      model: "m-no-last",
      prompt: "x",
      lastFrame: { url: "u" },
    }),
  ).toThrow(/does not support a last frame/)

  // omitted = unverified → passthrough
  expect(() =>
    guardFrameSupport([...GUARD_MODELS], {
      model: "m-unverified",
      prompt: "x",
      lastFrame: { url: "u" },
    }),
  ).not.toThrow()

  // unknown model id → passthrough (remote API decides)
  expect(() =>
    guardFrameSupport([...GUARD_MODELS], {
      model: "m-unknown",
      prompt: "x",
      firstFrame: { url: "u" },
      lastFrame: { url: "u" },
    }),
  ).not.toThrow()

  // supported slot passes
  expect(() =>
    guardFrameSupport([...GUARD_MODELS], {
      model: "m-no-last",
      prompt: "x",
      firstFrame: { url: "u" },
    }),
  ).not.toThrow()
})

// http

test("requestJson retries retryable status then succeeds", async () => {
  const mock = mockFetch([
    () => jsonResponse(429, { error: "rate" }),
    () => jsonResponse(429, { error: "rate" }),
    () => jsonResponse(200, { ok: true }),
  ])

  await expect(requestJson("https://example.test/x", { retries: 3 })).resolves.toEqual({ ok: true })
  expect(mock.recorded.length).toBe(3)

  mock.restore()
})

test("requestJson does not retry POST submits by default (billable)", async () => {
  const mock = mockFetch([
    () => jsonResponse(500, { error: "boom" }),
    () => jsonResponse(500, { error: "boom" }),
  ])

  await expect(
    requestJson("https://example.test/x", { method: "POST", body: { a: 1 } }),
  ).rejects.toMatchObject({ category: "internal" })
  expect(mock.recorded.length).toBe(1) // no second attempt

  mock.restore()
})

test("requestJson stops retrying once the caller aborts", async () => {
  const controller = new AbortController()
  const mock = mockFetch([
    () => jsonResponse(429, { error: "rate" }),
    () => {
      controller.abort()
      return jsonResponse(429, { error: "rate" })
    },
    () => jsonResponse(200, { ok: true }),
  ])

  await expect(
    requestJson("https://example.test/x", { retries: 5, signal: controller.signal }),
  ).rejects.toMatchObject({ message: "request aborted" })
  expect(mock.recorded.length).toBe(2) // third attempt never starts

  mock.restore()
})

test("requestJson classify hook takes precedence", async () => {
  const mock = mockFetch([() => jsonResponse(400, { code: "SensitiveContentDetected" })])

  await expect(
    requestJson("https://example.test/x", {
      classifyError: (status) => (status === 400 ? "moderation" : undefined),
    }),
  ).rejects.toMatchObject({ category: "moderation" })

  mock.restore()
})

test("requestJson honors Retry-After seconds on 429", async () => {
  const mock = mockFetch([
    () =>
      new Response(JSON.stringify({ error: "rate" }), {
        status: 429,
        headers: { "retry-after": "0" },
      }),
    () => jsonResponse(200, { ok: true }),
  ])

  const started = Date.now()
  await expect(requestJson("https://example.test/x", { retries: 2 })).resolves.toEqual({ ok: true })
  // retry-after: 0 → backoff sleep collapses to ~0 instead of 250-500ms jitter
  expect(Date.now() - started).toBeLessThan(200)
  expect(mock.recorded.length).toBe(2)

  mock.restore()
})

test("requestJson reports non-JSON 200 body without retrying", async () => {
  const mock = mockFetch([() => new Response("<html>gateway noise</html>", { status: 200 })])

  await expect(requestJson("https://example.test/x", { retries: 2 })).rejects.toMatchObject({
    category: "internal",
    message: expect.stringContaining("<html>gateway noise</html>"),
  })
  expect(mock.recorded.length).toBe(1) // parse failure on 200 is not retryable

  mock.restore()
})

test("requestJson surfaces non-JSON error pages with status and snippet", async () => {
  const mock = mockFetch([
    () => new Response("<html>Bad Gateway</html>", { status: 502 }),
    () => new Response("<html>Bad Gateway</html>", { status: 502 }),
    () => new Response("<html>Bad Gateway</html>", { status: 502 }),
  ])

  await expect(requestJson("https://example.test/x", { retries: 2 })).rejects.toMatchObject({
    category: "internal",
    message: expect.stringContaining("HTTP 502"),
    status: 502,
  })
  expect(mock.recorded.length).toBe(3) // 5xx error page stays retryable

  mock.restore()
})

test("requestJson sends auth headers and json body", async () => {
  const mock = mockFetch([() => jsonResponse(200, {})])

  await requestJson("https://example.test/x", {
    method: "POST",
    headers: { authorization: "Bearer t" },
    body: { a: 1 },
  })

  const { init } = at(mock.recorded, 0)
  expect(headersOf(at(mock.recorded, 0))["authorization"]).toBe("Bearer t")
  expect(init?.method).toBe("POST")

  mock.restore()
})

test("defaultClassifyError maps status and moderation keywords", () => {
  expect(defaultClassifyError(401, undefined)).toBe("auth")
  expect(defaultClassifyError(429, undefined)).toBe("rate")
  expect(defaultClassifyError(400, { error: { code: "content_policy_violation" } })).toBe(
    "moderation",
  )
  expect(defaultClassifyError(500, undefined)).toBe("internal")
})

test("createJsonClient merges base/dynamic headers and defaults", async () => {
  const mock = mockFetch([() => jsonResponse(200, { ok: 1 })])
  const client = createJsonClient({
    baseUrl: "https://api.test",
    headers: () => ({ authorization: "Bearer dyn" }),
    retries: 0,
  })

  await client.post<{ ok: number }>("/x", { a: 1 }, { headers: { "x-custom": "1" } })

  const rec = at(mock.recorded, 0)
  expect(rec.url).toBe("https://api.test/x")
  expect(headersOf(rec)["authorization"]).toBe("Bearer dyn")
  expect(headersOf(rec)["x-custom"]).toBe("1")
  expect(headersOf(rec)["content-type"]).toBe("application/json")

  mock.restore()
})

// fileref

test("toUrlRef passes through url, converts base64 and localPath with mime", async () => {
  expect(await toUrlRef({ url: "https://x.test/a.png" })).toEqual({ url: "https://x.test/a.png" })
  expect(await toUrlRef({ base64: "AAAA" })).toEqual({
    url: "data:application/octet-stream;base64,AAAA",
  })
  expect(await toUrlRef({ base64: "AAAA" }, "image/png")).toEqual({
    url: "data:image/png;base64,AAAA",
  })

  const tmp = await mkdtemp(join(tmpdir(), "fileref-"))
  try {
    const bin = join(tmp, "img.bin")
    await writeFile(bin, Buffer.from("hi"))
    expect(await toUrlRef({ localPath: bin })).toEqual({
      url: `data:application/octet-stream;base64,${Buffer.from("hi").toString("base64")}`,
    })

    const png = join(tmp, "img.png")
    await writeFile(png, Buffer.from("hi"))
    expect(await toUrlRef({ localPath: png })).toEqual({
      url: `data:image/png;base64,${Buffer.from("hi").toString("base64")}`,
    })
  } finally {
    await rm(tmp, { recursive: true })
  }
})

test("toUrlRef refuses oversized local files (sparse file probe)", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "fileref-"))
  try {
    const big = join(tmp, "big.bin")
    const fh = await open(big, "w")
    await fh.truncate(MAX_INLINE_BYTES + 1) // sparse: instant, no 50MB write
    await fh.close()

    await expect(toUrlRef({ localPath: big })).rejects.toThrow(/too large/)
  } finally {
    await rm(tmp, { recursive: true })
  }
})

// job

test("pollUntil resolves on done and times out", async () => {
  const handle = { providerId: "t", id: "1" }
  const final = await pollUntil(async () => ({ state: "pending" }) as const, handle, {
    intervalMs: 1,
    timeoutMs: 5,
  }).catch(() => ({ state: "failed" as const, error: { category: "internal" as const } }))

  expect(final.state).toBe("failed") // pending forever → timeout path exercised

  const done = await pollUntil(async () => ({ state: "done" as const, artifacts: [] }), handle, {
    intervalMs: 1,
    timeoutMs: 1000,
  })
  expect(done.state).toBe("done")

  await expect(
    pollUntil(async () => ({ state: "pending" as const }), handle, {
      intervalMs: 1,
      timeoutMs: 10,
    }),
  ).rejects.toBeInstanceOf(JobTimeoutError)
})

test("ProviderError carries category", () => {
  const e = new ProviderError("invalid", "bad input")
  expect(e.category).toBe("invalid")
  expect(e.name).toBe("ProviderError")
})
