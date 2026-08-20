import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadBuildManifest, validateBuildManifest } from "../manifest"

const FILE = "creatifact.json"

function parse(raw: unknown): ReturnType<typeof validateBuildManifest> {
  return validateBuildManifest(raw, FILE)
}

test("valid manifest with all fields passes", () => {
  const result = parse({
    annotations: { "org.creatifact.name": "pkg" },
    from: ["localhost:5000/base:1.0"],
    copy: [{ from: "localhost:5000/cuda:12.0", paths: ["cuda-libs"] }],
    assets: "./app",
  })
  expect(result).toEqual({
    annotations: { "org.creatifact.name": "pkg" },
    from: ["localhost:5000/base:1.0"],
    copy: [{ from: "localhost:5000/cuda:12.0", paths: ["cuda-libs"] }],
    assets: "./app",
  })
})

test("empty manifest passes", () => {
  expect(parse({})).toEqual({})
})

test("from string is kept as-is", () => {
  const result = parse({ from: "localhost:5000/base:1.0" })
  expect(result.from).toBe("localhost:5000/base:1.0")
})

test("from array validates each entry", () => {
  expect(() => parse({ from: ["ok:1", ""] })).toThrow("from[1]")
  expect(() => parse({ from: [123] })).toThrow("from[0]")
})

test("copy entry requires from and non-empty paths", () => {
  expect(() => parse({ copy: [{ paths: ["x"] }] })).toThrow("copy[0].from")
  expect(() => parse({ copy: [{ from: "r:1" }] })).toThrow("copy[0].paths")
  expect(() => parse({ copy: [{ from: "r:1", paths: [] }] })).toThrow("copy[0].paths")
  expect(() => parse({ copy: [{ from: "r:1", paths: [""] }] })).toThrow("paths[0]")
  expect(() => parse({ copy: "nope" })).toThrow("copy")
})

test("annotations values must be strings", () => {
  expect(() => parse({ annotations: { a: 1 } })).toThrow("annotations.a")
  expect(() => parse({ annotations: [] })).toThrow("annotations")
})

test("assets must be a non-empty string", () => {
  expect(() => parse({ assets: "" })).toThrow("assets")
  expect(() => parse({ assets: 5 })).toThrow("assets")
})

test("top level must be an object", () => {
  expect(() => parse("nope")).toThrow("top level")
  expect(() => parse(null)).toThrow("top level")
})

test("unknown fields warn and are ignored", () => {
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
  const result = parse({ asstes: "./x" })
  expect(result).toEqual({})
  expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("unknown field 'asstes'"))
  warnSpy.mockRestore()
})

test("legacy fields warn with migration hint", () => {
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
  const result = parse({ tag: "x:1", dir: "./d", output: "./o" })
  expect(result).toEqual({})
  expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'tag' was removed"))
  expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'dir' was removed"))
  expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'output' was removed"))
  warnSpy.mockRestore()
})

test("loadBuildManifest returns empty manifest when file missing", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "manifest-test-"))
  const result = await loadBuildManifest(join(tmp, "nope.json"))
  expect(result.file).toEqual({})
  expect(result.baseDir).toBe(tmp)
  await rm(tmp, { recursive: true })
})

test("loadBuildManifest parses and validates JSON", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "manifest-test-"))
  const filePath = join(tmp, "creatifact.json")
  await writeFile(filePath, JSON.stringify({ from: ["r:1"], assets: "./a" }))
  const result = await loadBuildManifest(filePath)
  expect(result.file).toEqual({ from: ["r:1"], assets: "./a" })
  expect(result.baseDir).toBe(tmp)
  await rm(tmp, { recursive: true })
})

test("loadBuildManifest propagates invalid JSON errors", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "manifest-test-"))
  const filePath = join(tmp, "creatifact.json")
  await writeFile(filePath, "{ invalid }")
  const error = await loadBuildManifest(filePath).catch((e) => e)
  expect(error.code).toBe("E_USAGE")
  expect(error.message).toContain("not valid JSON/JSONC")
  await rm(tmp, { recursive: true })
})

test("loadBuildManifest accepts JSONC comments and trailing commas", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "manifest-test-"))
  const filePath = join(tmp, "creatifact.json")
  await writeFile(
    filePath,
    `{
      // base layer
      "from": ["r:1"], /* inline note */
      "assets": "./a",
    }`,
  )
  const result = await loadBuildManifest(filePath)
  expect(result.file).toEqual({ from: ["r:1"], assets: "./a" })
  await rm(tmp, { recursive: true })
})

// gen.promptFile inlining

test("gen.promptFile with gen.prompt is rejected at validation", () => {
  expect(() => parse({ gen: { task: "text2image", prompt: "x", promptFile: "./p.md" } })).toThrow(
    "use either prompt or promptFile",
  )
})

test("gen.promptFile is inlined (trimmed) and dropped, for stages and top-level gen", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "manifest-test-"))
  await mkdir(join(tmp, "prompts"), { recursive: true })
  await writeFile(join(tmp, "prompts", "hero.md"), "hero on a cliff\n")
  await writeFile(
    join(tmp, "stage-build.json"),
    JSON.stringify({
      stages: [
        { name: "hero", gen: { task: "text2image", promptFile: "./prompts/hero.md" } },
        { name: "cat", gen: { task: "text2image", prompt: "a cat" } },
      ],
    }),
  )
  await writeFile(
    join(tmp, "top-build.json"),
    JSON.stringify({ gen: { task: "text2image", promptFile: "prompts/hero.md" } }),
  )

  const staged = await loadBuildManifest(join(tmp, "stage-build.json"))
  expect(staged.file.stages?.[0]?.gen).toEqual({ task: "text2image", prompt: "hero on a cliff" })
  expect(staged.file.stages?.[1]?.gen).toEqual({ task: "text2image", prompt: "a cat" })
  const top = await loadBuildManifest(join(tmp, "top-build.json"))
  expect(top.file.gen).toEqual({ task: "text2image", prompt: "hero on a cliff" })
  await rm(tmp, { recursive: true })
})

test("gen.promptFile errors name the manifest and the file", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "manifest-test-"))
  const missing = join(tmp, "missing-build.json")
  await writeFile(missing, JSON.stringify({ gen: { task: "text2image", promptFile: "./nope.md" } }))
  const missingError = await loadBuildManifest(missing).catch((e) => e)
  expect(missingError.code).toBe("E_USAGE")
  expect(missingError.message).toContain("./nope.md")

  await writeFile(join(tmp, "empty.md"), "  \n")
  const empty = join(tmp, "empty-build.json")
  await writeFile(empty, JSON.stringify({ gen: { task: "text2image", promptFile: "./empty.md" } }))
  const emptyError = await loadBuildManifest(empty).catch((e) => e)
  expect(emptyError.code).toBe("E_USAGE")
  expect(emptyError.message).toContain("is empty")
  await rm(tmp, { recursive: true })
})

test("gen field is validated and normalized", () => {
  const result = parse({
    gen: {
      task: "image2image",
      provider: "zhipu",
      model: "cogview-4",
      prompt: "a crane",
      options: { size: "1024x1024" },
      images: "a.png",
    },
  })
  expect(result.gen).toEqual({
    task: "image2image",
    provider: "zhipu",
    model: "cogview-4",
    prompt: "a crane",
    options: { size: "1024x1024" },
    images: ["a.png"],
  })
})

test("gen field rejects missing task, unknown task, and resume", () => {
  expect(() => parse({ gen: { provider: "zhipu" } })).toThrow("gen.task")
  expect(() => parse({ gen: { task: "nope" } })).toThrow("gen.task")
  expect(() => parse({ gen: { task: "resume" } })).toThrow("gen.task")
  expect(() => parse({ gen: "nope" })).toThrow("gen ")
})

test("gen field rejects bad options and images", () => {
  expect(() => parse({ gen: { task: "text2image", options: [] } })).toThrow("gen.options")
  expect(() => parse({ gen: { task: "text2image", images: [] } })).toThrow("gen.images")
  expect(() => parse({ gen: { task: "text2image", provider: "" } })).toThrow("gen.provider")
})
