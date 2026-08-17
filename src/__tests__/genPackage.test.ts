import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildResultPackage,
  GEN_CONFIG_MEDIA_TYPE,
  parseGenConfigBlob,
  validateGenSpec,
} from "../genPackage"

test("validateGenSpec normalizes inputs and rejects bad specs", () => {
  expect(validateGenSpec({ lane: "image", provider: "zhipu" }, "m")).toEqual({
    lane: "image",
    provider: "zhipu",
  })
  expect(validateGenSpec({ lane: "embed", input: "a" }, "m")).toEqual({
    lane: "embed",
    input: ["a"],
  })
  expect(() => validateGenSpec({}, "m")).toThrow(/gen\.lane/)
  expect(() => validateGenSpec({ lane: "resume" }, "m")).toThrow(/gen\.lane/)
  expect(() => validateGenSpec({ lane: "image", options: [] }, "m")).toThrow(/gen\.options/)
  expect(() => validateGenSpec({ lane: "image", input: [] }, "m")).toThrow(/gen\.input/)
})

test("validateGenSpec warns on unknown fields", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const spec = validateGenSpec({ lane: "image", prompte: "x" }, "m")
  expect(spec).toEqual({ lane: "image" })
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown field 'prompte'"))
  warn.mockRestore()
})

test("parseGenConfigBlob requires schemaVersion 1 and valid JSON", () => {
  const ok = parseGenConfigBlob(
    Buffer.from(JSON.stringify({ schemaVersion: 1, gen: { lane: "text" } })),
    "ref",
  )
  expect(ok.gen.lane).toBe("text")

  expect(() => parseGenConfigBlob(Buffer.from("{}"), "ref")).toThrow(/schemaVersion/)
  expect(() => parseGenConfigBlob(Buffer.from("{broken"), "ref")).toThrow(/not valid JSON/)
  expect(() => parseGenConfigBlob(Buffer.from("[]"), "ref")).toThrow(/must be a JSON object/)
})

test("buildResultPackage records provenance and packs base64 artifacts", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "gen-pkg-"))
  const outputDir = join(tmp, "out")

  await buildResultPackage({
    outputDir,
    tag: "org/result:1.0",
    fromRef: "example.com/xxxxxx:v1.0",
    artifacts: [
      { url: "https://cdn.test/a.png", mimeType: "image/png" },
      { base64: Buffer.from("png-bytes").toString("base64"), mimeType: "image/png" },
    ],
    spec: {
      lane: "image",
      provider: "zhipu",
      model: "cogview-3-flash",
      prompt: "a crane",
      options: { size: "1024x1024" },
    },
    usage: { native: { tokens: 5 } },
    createdAt: "2026-08-17T00:00:00.000Z",
  })

  const index = JSON.parse(await readFile(join(outputDir, "index.json"), "utf8"))
  expect(index.manifests[0].annotations["org.opencontainers.image.ref.name"]).toBe("org/result:1.0")

  const manifest = JSON.parse(
    await readFile(join(outputDir, "blobs", "sha256", index.manifests[0].digest.slice(7)), "utf8"),
  )
  expect(manifest.config.mediaType).toBe(GEN_CONFIG_MEDIA_TYPE)
  expect(manifest.layers).toHaveLength(1)
  expect(manifest.annotations["org.openmm.gen.provider"]).toBe("zhipu")

  const config = JSON.parse(
    await readFile(join(outputDir, "blobs", "sha256", manifest.config.digest.slice(7)), "utf8"),
  )
  expect(config.gen).toEqual({
    lane: "image",
    provider: "zhipu",
    model: "cogview-3-flash",
    prompt: "a crane",
    options: { size: "1024x1024" },
  })
  expect(config.result).toEqual({
    createdAt: "2026-08-17T00:00:00.000Z",
    from: "example.com/xxxxxx:v1.0",
    usage: { native: { tokens: 5 } },
    artifacts: [
      { url: "https://cdn.test/a.png", mimeType: "image/png" },
      { name: "artifact-2.png", mimeType: "image/png" },
    ],
  })

  await rm(tmp, { recursive: true, force: true })
})

test("buildResultPackage refuses a non-empty output dir", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "gen-pkg-"))
  const outputDir = join(tmp, "out")
  const { mkdir, writeFile } = await import("node:fs/promises")
  await mkdir(outputDir, { recursive: true })
  await writeFile(join(outputDir, "blocking.txt"), "x")

  await expect(
    buildResultPackage({
      outputDir,
      tag: "x:1",
      artifacts: [],
      spec: { lane: "image", provider: "zhipu" },
    }),
  ).rejects.toThrow(/not empty/)

  await rm(tmp, { recursive: true, force: true })
})
