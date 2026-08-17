import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadBuildManifest, validateBuildManifest } from "../manifest"

const FILE = "openmm-build.json"

function parse(raw: unknown): ReturnType<typeof validateBuildManifest> {
  return validateBuildManifest(raw, FILE)
}

test("valid manifest with all fields passes", () => {
  const result = parse({
    annotations: { "org.openmm.name": "pkg" },
    from: ["localhost:5000/base:1.0"],
    copy: [{ from: "localhost:5000/cuda:12.0", paths: ["cuda-libs"] }],
    assets: "./app",
  })
  expect(result).toEqual({
    annotations: { "org.openmm.name": "pkg" },
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
  const filePath = join(tmp, "openmm-build.json")
  await writeFile(filePath, JSON.stringify({ from: ["r:1"], assets: "./a" }))
  const result = await loadBuildManifest(filePath)
  expect(result.file).toEqual({ from: ["r:1"], assets: "./a" })
  expect(result.baseDir).toBe(tmp)
  await rm(tmp, { recursive: true })
})

test("loadBuildManifest propagates invalid JSON errors", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "manifest-test-"))
  const filePath = join(tmp, "openmm-build.json")
  await writeFile(filePath, "{ invalid }")
  await expect(loadBuildManifest(filePath)).rejects.toThrow()
  await rm(tmp, { recursive: true })
})

test("gen field is validated and normalized", () => {
  const result = parse({
    gen: {
      lane: "image",
      provider: "zhipu",
      model: "cogview-3-flash",
      prompt: "a crane",
      options: { size: "1024x1024" },
      input: "a.png",
    },
  })
  expect(result.gen).toEqual({
    lane: "image",
    provider: "zhipu",
    model: "cogview-3-flash",
    prompt: "a crane",
    options: { size: "1024x1024" },
    input: ["a.png"],
  })
})

test("gen field rejects missing lane and unknown lane", () => {
  expect(() => parse({ gen: { provider: "zhipu" } })).toThrow("gen.lane")
  expect(() => parse({ gen: { lane: "resume" } })).toThrow("gen.lane")
  expect(() => parse({ gen: "nope" })).toThrow("gen ")
})

test("gen field rejects bad options and input", () => {
  expect(() => parse({ gen: { lane: "image", options: [] } })).toThrow("gen.options")
  expect(() => parse({ gen: { lane: "image", input: [] } })).toThrow("gen.input")
  expect(() => parse({ gen: { lane: "image", provider: "" } })).toThrow("gen.provider")
})
