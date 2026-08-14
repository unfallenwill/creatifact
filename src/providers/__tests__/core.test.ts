import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "vitest"
import { loadCredentials } from "../core/config"
import { toUrlRef } from "../core/fileref"
import { defaultClassifyError, requestJson } from "../core/http"
import { JobTimeoutError, pollUntil } from "../core/job"
import { ProviderRegistry } from "../core/registry"
import { ProviderError } from "../core/types"
import { at, headersOf, jsonResponse, mockFetch } from "./helpers"

// registry

test("registry registers, gets, and rejects duplicates", () => {
  const registry = new ProviderRegistry()
  const provider = {
    id: "test",
    capabilities: ["video.generate"] as const,
    models: [],
    videoGenerate: {} as never,
  }
  registry.register(provider)
  expect(registry.get("test").id).toBe("test")
  expect(() => registry.register(provider)).toThrow("already registered")
  expect(() => registry.get("nope")).toThrow("not registered")
})

test("registry lists by capability", () => {
  const registry = new ProviderRegistry()
  registry.register({
    id: "a",
    capabilities: ["image.generate"] as const,
    models: [],
    imageGenerate: {} as never,
  })
  registry.register({
    id: "b",
    capabilities: ["video.generate", "image.generate"] as const,
    models: [],
    videoGenerate: {} as never,
    imageGenerate: {} as never,
  })
  expect(registry.listByCapability("video.generate").map((p) => p.id)).toEqual(["b"])
  expect(registry.listByCapability("image.generate").map((p) => p.id)).toEqual(["a", "b"])
})

// http

test("requestJson classifies errors and does not retry non-retryable status", async () => {
  const mock = mockFetch([() => jsonResponse(401, { error: { message: "bad key" } })])

  await expect(requestJson("https://example.test/x")).rejects.toMatchObject({
    category: "auth",
    message: "bad key",
  })
  expect(mock.recorded.length).toBe(1)

  mock.restore()
})

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

test("requestJson classify hook takes precedence", async () => {
  const mock = mockFetch([() => jsonResponse(400, { code: "SensitiveContentDetected" })])

  await expect(
    requestJson("https://example.test/x", {
      classifyError: (status) => (status === 400 ? "moderation" : undefined),
    }),
  ).rejects.toMatchObject({ category: "moderation" })

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

// fileref

test("toUrlRef passes through url, converts base64 and localPath", async () => {
  expect(toUrlRef({ url: "https://x.test/a.png" })).toEqual({ url: "https://x.test/a.png" })
  expect(toUrlRef({ base64: "AAAA" })).toEqual({
    url: "data:application/octet-stream;base64,AAAA",
  })

  const tmp = await mkdtemp(join(tmpdir(), "fileref-"))
  const file = join(tmp, "img.bin")
  await writeFile(file, Buffer.from("hi"))
  expect(toUrlRef({ localPath: file })).toEqual({
    url: `data:application/octet-stream;base64,${Buffer.from("hi").toString("base64")}`,
  })
  await rm(tmp, { recursive: true })
})

// config

let configDir: string

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "openmmcli-config-"))
})

afterEach(async () => {
  await rm(configDir, { recursive: true })
})

test("loadCredentials prefers env over config file", async () => {
  const configPath = join(configDir, "config.json")
  await writeFile(
    configPath,
    JSON.stringify({
      providers: {
        ark: { apiKey: "file-ark" },
        kling: { accessKey: "file-ak", secretKey: "file-sk" },
      },
    }),
  )

  const creds = loadCredentials({ ARK_API_KEY: "env-ark", KLING_ACCESS_KEY: "env-ak" }, configPath)
  expect(creds.arkApiKey).toBe("env-ark")
  expect(creds.klingAccessKey).toBe("env-ak")
  expect(creds.klingSecretKey).toBe("file-sk")
})

test("loadCredentials handles missing config file", () => {
  const creds = loadCredentials({ MINIMAX_API_KEY: "mm" }, "/nonexistent/config.json")
  expect(creds.minimaxApiKey).toBe("mm")
  expect(creds.arkApiKey).toBeUndefined()
})

// job

test("pollUntil returns terminal status", async () => {
  const statuses = [{ state: "pending" }, { state: "running" }, { state: "done", artifacts: [] }]
  let i = 0
  const result = await pollUntil(
    async () => statuses[i++] as never,
    { providerId: "t", id: "1" },
    { intervalMs: 1, timeoutMs: 1000 },
  )
  expect(result.state).toBe("done")
})

test("pollUntil throws on timeout", async () => {
  await expect(
    pollUntil(
      async () => ({ state: "pending" }),
      { providerId: "t", id: "1" },
      { intervalMs: 1, timeoutMs: 5 },
    ),
  ).rejects.toBeInstanceOf(JobTimeoutError)
})

// types

test("ProviderError carries category and raw", () => {
  const err = new ProviderError("quota", "no credit", { code: 402 }, 402)
  expect(err.category).toBe("quota")
  expect(err.status).toBe(402)
  expect(err.raw).toEqual({ code: 402 })
})
