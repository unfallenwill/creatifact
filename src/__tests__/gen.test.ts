import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "vitest"
import { parseGenArgs, resolveLane, toFileRef } from "../gen"
import type { Capability, Provider } from "../providers"
import { parseDurationMs, parseKvValue } from "../util"

test("parseGenArgs splits provider/model and collects repeats", () => {
  const p = parseGenArgs([
    "zhipu/cogview-3-flash",
    "--prompt",
    "a crane",
    "--opt",
    "quality=hd",
    "--opt",
    "size=1024x1024",
    "--input",
    "a",
    "--input",
    "b",
    "--no-wait",
    "--timeout",
    "5m",
    "--interval",
    "250ms",
  ])
  expect(p.target).toBe("zhipu/cogview-3-flash")
  expect(p.prompt).toBe("a crane")
  expect(p.opts).toEqual({ quality: "hd", size: "1024x1024" })
  expect(p.inputs).toEqual(["a", "b"])
  expect(p.noWait).toBe(true)
  expect(p.timeoutMs).toBe(300_000)
  expect(p.intervalMs).toBe(250)
})

test("parseGenArgs coerces --opt values like config set", () => {
  const p = parseGenArgs([
    "x/y",
    "--opt",
    "duration=5",
    "--opt",
    "with_audio=true",
    "--opt",
    'request_id="12345"',
  ])
  expect(p.opts).toEqual({ duration: 5, with_audio: true, request_id: "12345" })
})

test("parseGenArgs rejects malformed --opt", () => {
  expect(() => parseGenArgs(["x/y", "--opt", "novalue"])).toThrow(/expected k=v/)
  expect(() => parseGenArgs(["x/y", "--opt", "=v"])).toThrow(/expected k=v/)
})

test("parseGenArgs rejects invalid durations", () => {
  expect(() => parseGenArgs(["x/y", "--timeout", "abc"])).toThrow(/invalid --timeout/)
  expect(() => parseGenArgs(["x/y", "--interval", "-5s"])).toThrow(/invalid --interval/)
})

test("parseDurationMs accepts units and bare seconds", () => {
  expect(parseDurationMs("600", "--timeout")).toBe(600_000)
  expect(parseDurationMs("90s", "--timeout")).toBe(90_000)
  expect(parseDurationMs("5m", "--timeout")).toBe(300_000)
  expect(parseDurationMs("2h", "--timeout")).toBe(7_200_000)
})

test("parseKvValue falls back to the raw string", () => {
  expect(parseKvValue("5")).toBe(5)
  expect(parseKvValue("true")).toBe(true)
  expect(parseKvValue("1920x1080")).toBe("1920x1080")
})

const API_METHOD: Record<Capability, string> = {
  "video.generate": "videoGenerate",
  "video.understand": "videoUnderstand",
  "image.generate": "imageGenerate",
  "image.understand": "imageUnderstand",
  embed: "embed",
}

function fakeProvider(models: { id: string; caps: Capability[] }[], apis: Capability[]): Provider {
  const provider: Record<string, unknown> = {
    id: "fake",
    models: models.map((m) => ({
      id: m.id,
      capabilities: Object.fromEntries(m.caps.map((c) => [c, {}])),
      lastVerified: "2026-08",
    })),
  }
  for (const api of apis) {
    provider[API_METHOD[api]] = {}
  }
  return provider as unknown as Provider
}

test("resolveLane picks the single declared capability", () => {
  const provider = fakeProvider(
    [{ id: "m", caps: ["image.generate"] }],
    ["image.generate", "video.generate"],
  )
  expect(resolveLane(provider, "m", { prompt: true, ask: false, inputs: 0 })).toBe("image.generate")
})

test("resolveLane intersects declared capabilities with implemented APIs", () => {
  const provider = fakeProvider([{ id: "m", caps: ["image.generate", "embed"] }], ["embed"])
  expect(resolveLane(provider, "m", { prompt: false, ask: false, inputs: 1 })).toBe("embed")

  const impossible = fakeProvider([{ id: "m", caps: ["video.generate"] }], ["embed"])
  expect(() => resolveLane(impossible, "m", { prompt: true, ask: false, inputs: 0 })).toThrow(
    /declares no capability/,
  )
})

test("resolveLane collapses understand pairs and honors triggers", () => {
  const vision = fakeProvider(
    [{ id: "m", caps: ["image.understand", "video.understand"] }],
    ["image.understand", "video.understand"],
  )
  expect(resolveLane(vision, "m", { prompt: false, ask: true, inputs: 0 })).toBe("image.understand")

  const multi = fakeProvider(
    [{ id: "m", caps: ["image.generate", "image.understand"] }],
    ["image.generate", "image.understand"],
  )
  expect(resolveLane(multi, "m", { prompt: false, ask: true, inputs: 0 })).toBe("image.understand")
  expect(resolveLane(multi, "m", { prompt: true, ask: false, inputs: 0 })).toBe("image.generate")
  expect(() => resolveLane(multi, "m", { prompt: false, ask: false, inputs: 0 })).toThrow(
    /multiple lanes/,
  )
})

test("resolveLane passes unknown models through to all provider APIs", () => {
  const provider = fakeProvider([], ["embed"])
  expect(resolveLane(provider, "anything", { prompt: false, ask: false, inputs: 1 })).toBe("embed")
})

test("toFileRef maps URLs and existing paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gen-test-"))
  try {
    expect(toFileRef("https://x.test/a.png", "--image")).toEqual({ url: "https://x.test/a.png" })
    expect(toFileRef("data:image/png;base64,xx", "--image")).toEqual({
      url: "data:image/png;base64,xx",
    })
    const local = join(dir, "f.png")
    await writeFile(local, "x")
    expect(toFileRef(local, "--image")).toEqual({ localPath: local })
    expect(() => toFileRef(join(dir, "missing.png"), "--image")).toThrow(/file not found/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
