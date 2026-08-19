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
  expect(validateGenSpec({ task: "image2image", provider: "zhipu" }, "m")).toEqual({
    task: "image2image",
    provider: "zhipu",
  })
  expect(validateGenSpec({ task: "embed", inputs: "a" }, "m")).toEqual({
    task: "embed",
    inputs: ["a"],
  })
  expect(validateGenSpec({ task: "image2video", images: ["a.png"] }, "m")).toEqual({
    task: "image2video",
    images: ["a.png"],
  })
  expect(() => validateGenSpec({}, "m")).toThrow(/gen\.task/)
  expect(() => validateGenSpec({ task: "nope" }, "m")).toThrow(/gen\.task/)
  expect(() => validateGenSpec({ task: "resume" }, "m")).toThrow(/gen\.task/)
  expect(() => validateGenSpec({ task: "text2image", options: [] }, "m")).toThrow(/gen\.options/)
  expect(() => validateGenSpec({ task: "text2image", images: [] }, "m")).toThrow(/gen\.images/)
})

test("validateGenSpec warns on unknown fields", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const spec = validateGenSpec({ task: "text2image", prompte: "x" }, "m")
  expect(spec).toEqual({ task: "text2image" })
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown field 'prompte'"))
  warn.mockRestore()
})

test("parseGenConfigBlob requires schemaVersion 1 and valid JSON", () => {
  const ok = parseGenConfigBlob(
    Buffer.from(JSON.stringify({ schemaVersion: 1, gen: { task: "text2text" } })),
    "ref",
  )
  expect(ok.gen.task).toBe("text2text")

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
      task: "image2image",
      provider: "zhipu",
      model: "cogview-4",
      prompt: "a crane",
      images: ["pkg://refs/cat.png"],
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
  expect(manifest.annotations["org.openmm.gen.task"]).toBe("image2image")
  expect(manifest.annotations["org.openmm.gen.provider"]).toBe("zhipu")

  const config = JSON.parse(
    await readFile(join(outputDir, "blobs", "sha256", manifest.config.digest.slice(7)), "utf8"),
  )
  expect(config.gen).toEqual({
    task: "image2image",
    provider: "zhipu",
    model: "cogview-4",
    prompt: "a crane",
    images: ["pkg://refs/cat.png"],
    options: { size: "1024x1024" },
  })
  expect(config.result.from).toBe("example.com/xxxxxx:v1.0")

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
      spec: { task: "text2image", provider: "zhipu" },
    }),
  ).rejects.toThrow(/not empty/)

  await rm(tmp, { recursive: true, force: true })
})

test("store mode dedups blobs and replaces the tag entry on rebuild", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "gen-store-"))
  const store = join(tmp, "store")
  const spec = { task: "text2image" as const, provider: "zhipu" }
  const artifact = {
    base64: Buffer.from("same-bytes").toString("base64"),
    mimeType: "image/png",
  }

  const first = await buildResultPackage({
    outputDir: store,
    tag: "gen-output:latest",
    store: true,
    artifacts: [artifact],
    spec,
    createdAt: "2026-08-17T00:00:00.000Z",
  })
  const second = await buildResultPackage({
    outputDir: store,
    tag: "other:1",
    store: true,
    artifacts: [artifact],
    spec,
    createdAt: "2026-08-17T00:00:00.000Z",
  })

  // identical artifacts/config → identical digests: blobs shared, single copy
  expect(first.digest).toBe(second.digest)
  const index = JSON.parse(await readFile(join(store, "index.json"), "utf8"))
  expect(index.manifests).toHaveLength(2)

  // re-tag gen-output:latest → pointer moves, other tags survive
  await buildResultPackage({
    outputDir: store,
    tag: "gen-output:latest",
    store: true,
    artifacts: [],
    spec,
    createdAt: "2026-08-18T00:00:00.000Z",
  })
  const after = JSON.parse(await readFile(join(store, "index.json"), "utf8"))
  const refs = after.manifests.map(
    (m: { annotations?: Record<string, string> }) =>
      m.annotations?.["org.opencontainers.image.ref.name"],
  )
  expect(refs.sort()).toEqual(["gen-output:latest", "other:1"])

  await rm(tmp, { recursive: true, force: true })
})
