import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type GenRequest,
  mergeRequest,
  type ProviderContext,
  parseGenerateArgs,
  pickModelForTask,
  requestFieldsForTask,
  splitProviderPositional,
  TASKS,
  toFileRef,
  validateRequest,
} from "../generate"
import type { ModelSupport, Provider } from "../providers"
import { parseDurationMs, parseKvValue } from "../util"

const CTX: ProviderContext = { known: new Set(["demo"]), hasDefaultProvider: false }
const DEFAULTED: ProviderContext = { known: new Set(["demo"]), hasDefaultProvider: true }

function req(task: GenRequest["task"], fields: Partial<GenRequest> = {}): GenRequest {
  return { task, ...fields }
}

// --- parse -----------------------------------------------------------------

test("parseGenerateArgs: provider positional, prompt, repeats, flags", () => {
  const o = parseGenerateArgs(
    "image2image",
    [
      "demo/img-model",
      "a crane",
      "--image",
      "ref.png",
      "--opt",
      "quality=hd",
      "--opt",
      "size=1024x1024",
      "--output",
      "out",
      "--tag",
      "r:1",
    ],
    CTX,
  )
  expect(o).toMatchObject({
    task: "image2image",
    provider: "demo",
    model: "img-model",
    prompt: "a crane",
    images: ["ref.png"],
    options: { quality: "hd", size: "1024x1024" },
    output: "out",
    tag: "r:1",
  })
})

test("parseGenerateArgs: --provider/--model flags replace the positional", () => {
  const o = parseGenerateArgs("text2image", ["--provider", "demo", "--model", "m1", "a crane"], CTX)
  expect(o.provider).toBe("demo")
  expect(o.model).toBe("m1")
  expect(o.prompt).toBe("a crane")
})

test("parseGenerateArgs: provider positional + provider flag conflict", () => {
  expect(() => parseGenerateArgs("text2image", ["demo/m", "x", "--provider", "demo"], CTX)).toThrow(
    /conflicting provider/,
  )
})

test("parseGenerateArgs: positional prompt vs --prompt are mutually exclusive", () => {
  expect(() => parseGenerateArgs("text2image", ["demo", "pos", "--prompt", "flag"], CTX)).toThrow(
    /mutually exclusive/,
  )
})

test("parseGenerateArgs: embed positionals are inputs; --prompt rejected", () => {
  const o = parseGenerateArgs("embed", ["demo/embed", "a", "b", "--input", "c"], CTX)
  expect(o.inputs).toEqual(["a", "b", "c"])
  expect(() => parseGenerateArgs("embed", ["demo", "--prompt", "x"], CTX)).toThrow(/--prompt/)
})

test("parseGenerateArgs: resume takes a handle positional", () => {
  const o = parseGenerateArgs("resume", ['{"providerId":"demo","id":"t"}', "--interval", "1s"], CTX)
  expect(o.handle).toBe('{"providerId":"demo","id":"t"}')
  expect(o.interval).toBe("1s")
})

test("parseGenerateArgs: packageMode disables the provider positional", () => {
  const o = parseGenerateArgs("image2image", ["a crane", "--image", "x.png"], CTX, {
    packageMode: true,
  })
  expect(o.prompt).toBe("a crane")
  expect(o.images).toEqual(["x.png"])
  expect(o.provider).toBeUndefined()
})

test("parseGenerateArgs: task-inapplicable flags fail at parse time", () => {
  expect(() =>
    parseGenerateArgs("image2text", ["what is this", "--first-frame", "f.png"], CTX),
  ).toThrow(/unknown option '--first-frame'/)
  expect(() => parseGenerateArgs("text2text", ["hi", "--no-wait"], CTX)).toThrow(
    /unknown option '--no-wait'/,
  )
})

test("parseGenerateArgs: malformed provider targets and opt values", () => {
  expect(() => parseGenerateArgs("text2image", ["a/b/c", "x"], CTX)).toThrow(/expected <provider>/)
  expect(() => parseGenerateArgs("text2image", ["demo", "x", "--opt", "novalue"], CTX)).toThrow(
    /expected k=v/,
  )
})

test("parseGenerateArgs: non-provider first positional uses the default provider", () => {
  const o = parseGenerateArgs("text2image", ["a crane"], DEFAULTED)
  expect(o.prompt).toBe("a crane")
  expect(o.provider).toBeUndefined()
  expect(() => parseGenerateArgs("text2image", ["a crane"], CTX)).toThrow(/expected <provider>/)
})

// --- validate --------------------------------------------------------------

test("validateRequest: required prompt", () => {
  expect(() => validateRequest(req("text2image"))).toThrow(/text2image requires a prompt/)
  expect(() => validateRequest(req("text2image", { prompt: "x" }))).not.toThrow()
})

test("validateRequest: image2image needs exactly one image", () => {
  expect(() => validateRequest(req("image2image", { prompt: "x" }))).toThrow(
    /image2image requires --image/,
  )
  expect(() =>
    validateRequest(req("image2image", { prompt: "x", images: ["a.png", "b.png"] })),
  ).toThrow(/exactly one --image/)
  expect(() =>
    validateRequest(req("image2image", { prompt: "x", images: ["a.png"] })),
  ).not.toThrow()
})

test("validateRequest: text2video rejects --first-frame with guidance", () => {
  expect(() => validateRequest(req("text2video", { prompt: "x", firstFrame: "a.png" }))).toThrow(
    /text2video does not take --first-frame.*image2video/s,
  )
})

test("validateRequest: frames2video requires both frames", () => {
  expect(() => validateRequest(req("frames2video", { prompt: "x", lastFrame: "b.png" }))).toThrow(
    /requires --first-frame/,
  )
  expect(() => validateRequest(req("frames2video", { prompt: "x", firstFrame: "a.png" }))).toThrow(
    /requires --last-frame/,
  )
  expect(() =>
    validateRequest(req("frames2video", { prompt: "x", firstFrame: "a.png", lastFrame: "b.png" })),
  ).not.toThrow()
})

test("validateRequest: image2video rejects first/last-frame flags", () => {
  expect(() =>
    validateRequest(req("image2video", { prompt: "x", images: ["a.png"], firstFrame: "a.png" })),
  ).toThrow(/frames2video/)
})

test("validateRequest: text2image rejects --image with guidance", () => {
  expect(() => validateRequest(req("text2image", { prompt: "x", images: ["a.png"] }))).toThrow(
    /text2image does not take --image.*image2image/s,
  )
})

test("validateRequest: task-scoped flags", () => {
  expect(() => validateRequest(req("text2text", { prompt: "x", noWait: true }))).toThrow(
    /--no-wait/,
  )
  expect(() => validateRequest(req("text2image", { prompt: "x", system: "s" }))).toThrow(/--system/)
  expect(() => validateRequest(req("text2text", { prompt: "x", timeout: "5m" }))).toThrow(
    /--timeout/,
  )
  expect(() => validateRequest(req("embed", { prompt: "x", inputs: ["a"] }))).toThrow(/--input/)
  expect(() => validateRequest(req("image2text", { inputs: ["a.png"] }))).not.toThrow()
  expect(() => validateRequest(req("video2text", { inputs: ["a.mp4"] }))).not.toThrow()
  expect(() =>
    validateRequest(
      req("text2video", { prompt: "x", noWait: true, timeout: "5m", interval: "5s" }),
    ),
  ).not.toThrow()
  expect(() => validateRequest(req("text2text", { prompt: "x", tag: "t:1" }))).toThrow(/--tag/)
})

test("validateRequest: durations must parse", () => {
  expect(() => validateRequest(req("text2video", { prompt: "x", timeout: "abc" }))).toThrow(
    /invalid --timeout/,
  )
})

// --- merge -----------------------------------------------------------------

test("mergeRequest: scalars override, arrays replace, options shallow-merge", () => {
  const base = req("image2image", {
    prompt: "base",
    images: ["a.png", "b.png"],
    options: { size: "1024x1024", quality: "standard" },
    noPack: false,
  })
  const merged = mergeRequest(base, {
    prompt: "cli",
    images: ["c.png"],
    options: { quality: "hd" },
  })
  expect(merged.prompt).toBe("cli")
  expect(merged.images).toEqual(["c.png"])
  expect(merged.options).toEqual({ size: "1024x1024", quality: "hd" })
  expect(merged.noPack).toBe(false)
})

test("mergeRequest: absent overlay fields never override", () => {
  const merged = mergeRequest(req("text2image", { prompt: "base", images: ["a.png"] }), {
    noPack: true,
  })
  expect(merged.prompt).toBe("base")
  expect(merged.images).toEqual(["a.png"])
  expect(merged.noPack).toBe(true)
})

// --- model picking ----------------------------------------------------------

function providerWith(
  models: Array<{ id: string; support: ModelSupport }>,
  defaults?: Record<string, string>,
): Provider {
  return {
    id: "fake",
    models: models.map((m) => ({
      id: m.id,
      capabilities: { "video.generate": m.support },
      lastVerified: "2026-08",
    })),
    ...(defaults === undefined ? {} : { defaultModels: defaults }),
  } as unknown as Provider
}

test("pickModelForTask: declared default wins when it satisfies the filter", () => {
  const p = providerWith(
    [
      { id: "t2v", support: { textOnly: true } },
      { id: "i2v", support: { firstFrame: true } },
    ],
    { "video.generate": "t2v" },
  )
  expect(pickModelForTask(p, "text2video")).toEqual({ model: "t2v", warned: false })
})

test("pickModelForTask: filter picks a verified model when the default fails", () => {
  const p = providerWith(
    [
      { id: "i2v-only", support: { textOnly: false, firstFrame: true } },
      { id: "t2v", support: { textOnly: true } },
    ],
    { "video.generate": "i2v-only" },
  )
  const picked = pickModelForTask(p, "text2video")
  expect(picked.model).toBe("t2v")
  expect(picked.warned).toBe(true)
})

test("pickModelForTask: fallback to the capability default with a warning", () => {
  const p = providerWith([{ id: "i2v-only", support: { textOnly: false, firstFrame: true } }], {
    "video.generate": "i2v-only",
  })
  expect(pickModelForTask(p, "text2video")).toEqual({ model: "i2v-only", warned: true })
})

test("pickModelForTask: strict tasks hard-fail without a matching model", () => {
  const p = providerWith([{ id: "plain", support: { firstFrame: true } }])
  expect(() => pickModelForTask(p, "frames2video")).toThrow(
    /no verified model supporting frames2video/,
  )
})

test("pickModelForTask: image2image prefers imageInput models", () => {
  const p = {
    id: "fake",
    models: [
      { id: "t2i", capabilities: { "image.generate": {} }, lastVerified: "2026-08" },
      {
        id: "i2i",
        capabilities: { "image.generate": { imageInput: true } },
        lastVerified: "2026-08",
      },
    ],
    defaultModels: { "image.generate": "t2i" },
  } as unknown as Provider
  expect(pickModelForTask(p, "image2image").model).toBe("i2i")
})

// --- misc -------------------------------------------------------------------

test("requestFieldsForTask matches the task contracts", () => {
  expect([...requestFieldsForTask("text2text")].sort()).toEqual(
    ["model", "prompt", "provider", "system", "options"].sort(),
  )
  expect(requestFieldsForTask("image2image").has("images")).toBe(true)
  expect(requestFieldsForTask("text2image").has("images")).toBe(false)
  expect(requestFieldsForTask("frames2video").has("lastFrame")).toBe(true)
  expect(requestFieldsForTask("resume").has("handle")).toBe(true)
  expect(requestFieldsForTask("resume").has("output")).toBe(true)
  expect(requestFieldsForTask("resume").has("tag")).toBe(false)
  expect(requestFieldsForTask("text2video").has("noWait")).toBe(true)
  expect(requestFieldsForTask("text2image").has("noWait")).toBe(false)
})

test("splitProviderPositional treats known ids and slashes as providers", () => {
  expect(splitProviderPositional(["demo", "prompt"], CTX)).toEqual({
    target: "demo",
    payload: ["prompt"],
  })
  expect(splitProviderPositional(["a crane"], DEFAULTED)).toEqual({
    target: undefined,
    payload: ["a crane"],
  })
  expect(() => splitProviderPositional(["noslash", "x"], CTX)).toThrow(/expected <provider>/)
})

test("TASKS registry is complete and consistent", () => {
  expect(Object.keys(TASKS).sort()).toEqual(
    [
      "embed",
      "frames2video",
      "image2image",
      "image2text",
      "image2video",
      "text2image",
      "text2text",
      "text2video",
      "resume",
      "video2text",
    ].sort(),
  )
  for (const spec of Object.values(TASKS)) {
    expect(spec.capability === undefined ? "resume" : "x").toBeTruthy()
  }
})

test("toFileRef maps URLs and existing paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "generate-test-"))
  try {
    expect(toFileRef("https://x.test/a.png", "--image")).toEqual({ url: "https://x.test/a.png" })
    const local = join(dir, "f.png")
    await writeFile(local, "x")
    expect(toFileRef(local, "--image")).toEqual({ localPath: local })
    expect(() => toFileRef(join(dir, "missing.png"), "--image")).toThrow(/file not found/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("durations and kv values parse", () => {
  expect(parseDurationMs("600", "--timeout")).toBe(600_000)
  expect(parseDurationMs("5m", "--timeout")).toBe(300_000)
  expect(parseKvValue("true")).toBe(true)
  expect(parseKvValue("1024x1024")).toBe("1024x1024")
})
