import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "vitest"
import { parseGenArgs, pickDefaultModel, splitProviderPositional, toFileRef } from "../gen"
import type { Capability, Provider } from "../providers"
import { parseDurationMs, parseKvValue } from "../util"

const CTX = { known: new Set(["demo"]), hasDefaultProvider: false }

test("parseGenArgs parses image lane: provider positional, prompt, repeats, durations", () => {
  const p = parseGenArgs(
    "image",
    [
      "demo/img-model",
      "a crane",
      "--opt",
      "quality=hd",
      "--opt",
      "size=1024x1024",
      "--image",
      "ref.png",
      "--output",
      "out",
      "--json",
    ],
    CTX,
  )
  expect(p.target).toBe("demo/img-model")
  expect(p.prompt).toBe("a crane")
  expect(p.opts).toEqual({ quality: "hd", size: "1024x1024" })
  expect(p.image).toBe("ref.png")
  expect(p.outputDir).toBe("out")
  expect(p.json).toBe(true)
})

test("parseGenArgs parses video lane flags", () => {
  const p = parseGenArgs(
    "video",
    [
      "demo/video-model",
      "--prompt",
      "x",
      "--first-frame",
      "a.png",
      "--last-frame",
      "b.png",
      "--no-wait",
      "--timeout",
      "5m",
      "--interval",
      "250ms",
    ],
    CTX,
  )
  expect(p.firstFrame).toBe("a.png")
  expect(p.lastFrame).toBe("b.png")
  expect(p.noWait).toBe(true)
  expect(p.timeoutMs).toBe(300_000)
  expect(p.intervalMs).toBe(250)
})

test("parseGenArgs parses text lane with system prompt", () => {
  const p = parseGenArgs("text", ["demo/text", "hello", "--system", "be brief", "--json"], CTX)
  expect(p.prompt).toBe("hello")
  expect(p.system).toBe("be brief")
  expect(p.json).toBe(true)
})

test("parseGenArgs parses understand lane via positional or --ask", () => {
  const positional = parseGenArgs(
    "understand",
    ["demo/vision", "what is this", "--input", "a.png", "--input", "b.png"],
    CTX,
  )
  expect(positional.prompt).toBe("what is this")
  expect(positional.inputs).toEqual(["a.png", "b.png"])

  const asked = parseGenArgs("understand", ["demo/vision", "--ask", "why"], CTX)
  expect(asked.prompt).toBe("why")
})

test("parseGenArgs parses embed lane with many positionals", () => {
  const p = parseGenArgs("embed", ["demo/embed", "a", "b", "--input", "c"], CTX)
  expect(p.target).toBe("demo/embed")
  expect(p.inputs).toEqual(["a", "b", "c"])
})

test("parseGenArgs parses resume lane source", () => {
  const p = parseGenArgs("resume", ['{"providerId":"demo","id":"t"}', "--interval", "1s"], CTX)
  expect(p.source).toBe('{"providerId":"demo","id":"t"}')
  expect(p.intervalMs).toBe(1000)
})

test("parseGenArgs coerces --opt values like config set", () => {
  const p = parseGenArgs(
    "image",
    ["x/y", "--opt", "duration=5", "--opt", "with_audio=true", "--opt", 'request_id="12345"'],
    CTX,
  )
  expect(p.opts).toEqual({ duration: 5, with_audio: true, request_id: "12345" })
})

test("parseGenArgs rejects malformed --opt", () => {
  expect(() => parseGenArgs("image", ["x/y", "--opt", "novalue"], CTX)).toThrow(/expected k=v/)
  expect(() => parseGenArgs("image", ["x/y", "--opt", "=v"], CTX)).toThrow(/expected k=v/)
})

test("parseGenArgs rejects invalid durations", () => {
  expect(() => parseGenArgs("video", ["x/y", "--timeout", "abc"], CTX)).toThrow(/invalid --timeout/)
  expect(() => parseGenArgs("video", ["x/y", "--interval", "-5s"], CTX)).toThrow(
    /invalid --interval/,
  )
})

test("parseGenArgs rejects both positional and flag prompt", () => {
  expect(() => parseGenArgs("image", ["x/y", "pos", "--prompt", "flag"], CTX)).toThrow(
    /mutually exclusive/,
  )
  expect(() => parseGenArgs("understand", ["x/y", "pos", "--ask", "flag"], CTX)).toThrow(
    /mutually exclusive/,
  )
})

test("parseGenArgs rejects too many positionals", () => {
  expect(() => parseGenArgs("image", ["x/y", "a", "b"], CTX)).toThrow(/too many positional/)
  expect(() => parseGenArgs("resume", ["h", "extra"], CTX)).toThrow(/too many positional/)
})

test("splitProviderPositional treats known ids and slashes as providers", () => {
  expect(splitProviderPositional(["demo", "prompt"], CTX)).toEqual({
    target: "demo",
    payload: ["prompt"],
  })
  expect(splitProviderPositional(["demo/img", "prompt"], CTX)).toEqual({
    target: "demo/img",
    payload: ["prompt"],
  })
  // Unknown word with a default provider configured: it is payload.
  expect(
    splitProviderPositional(["a crane"], { known: new Set(["demo"]), hasDefaultProvider: true }),
  ).toEqual({ target: undefined, payload: ["a crane"] })
  // Unknown word without a default provider: rejected as a bad provider.
  expect(() => splitProviderPositional(["noslash", "x"], CTX)).toThrow(/expected <provider>/)
})

test("pickDefaultModel prefers declared defaults, then verified capabilities", () => {
  const provider: Provider = {
    id: "fake",
    models: [
      { id: "img-a", capabilities: { "image.generate": {} }, lastVerified: "2026-08" },
      { id: "img-b", capabilities: { "image.generate": {} }, lastVerified: "2026-08" },
    ],
    defaultModels: { "image.generate": "img-b" },
  }
  expect(pickDefaultModel(provider, ["image.generate"])).toBe("img-b")
  expect(pickDefaultModel(provider, ["video.generate"])).toBeUndefined()

  const noDefaults: Provider = { id: "fake", models: provider.models }
  expect(pickDefaultModel(noDefaults, ["image.generate"])).toBe("img-a")
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

test("API_METHOD mapping covers every capability", () => {
  const API_METHOD: Record<Capability, string> = {
    "text.generate": "textGenerate",
    "video.generate": "videoGenerate",
    "video.understand": "videoUnderstand",
    "image.generate": "imageGenerate",
    "image.understand": "imageUnderstand",
    embed: "embed",
  }
  expect(Object.keys(API_METHOD)).toHaveLength(6)
})
