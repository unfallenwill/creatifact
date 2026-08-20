import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  artifactFromStore,
  buildResultPackage,
  GEN_CONFIG_MEDIA_TYPE,
  parseGenConfigBlob,
  validateGenSpec,
} from "../genPackage"
import { mergeImageLayers } from "../layers"

test("artifactFromStore resolves bytes by digest+url and misses cleanly", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "gen-store-lookup-"))
  vi.stubEnv("CREATIFACT_CONFIG_DIR", tmp)
  try {
    const url = "https://cdn.test/src.png"
    const bytes = Buffer.from("SRCIMAGE")
    const built = await buildResultPackage({
      outputDir: join(tmp, "store"),
      tag: "demo/src:v1",
      store: true,
      fetchBytes: async () => bytes,
      artifacts: [{ url, mimeType: "image/png" }],
      spec: { task: "text2image", provider: "demo" },
      createdAt: "2026-08-17T00:00:00.000Z",
    })

    const hit = await artifactFromStore(built.digest, url)
    expect(hit).toEqual({ name: "artifact-1.png", bytes })

    // url mismatch / unknown digest / missing store → undefined, never throws
    expect(await artifactFromStore(built.digest, "https://cdn.test/other.png")).toBeUndefined()
    expect(await artifactFromStore(`sha256:${"0".repeat(64)}`, url)).toBeUndefined()
    expect(
      await artifactFromStore(built.digest, url, { configPath: "/nonexistent/cfg.json" }),
    ).toBeUndefined()
  } finally {
    vi.unstubAllEnvs()
    await rm(tmp, { recursive: true, force: true })
  }
})

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

test("buildResultPackage downloads url artifacts and packs base64, keeping provenance", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "gen-pkg-"))
  const outputDir = join(tmp, "out")
  const urlBytes = Buffer.from("url-png-bytes")

  const built = await buildResultPackage({
    outputDir,
    tag: "org/result:1.0",
    fromRef: "example.com/xxxxxx:v1.0",
    fetchBytes: async () => urlBytes,
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
  expect(built.warnings).toEqual([])

  const index = JSON.parse(await readFile(join(outputDir, "index.json"), "utf8"))
  expect(index.manifests[0].annotations["org.opencontainers.image.ref.name"]).toBe("org/result:1.0")

  const manifest = JSON.parse(
    await readFile(join(outputDir, "blobs", "sha256", index.manifests[0].digest.slice(7)), "utf8"),
  )
  expect(manifest.config.mediaType).toBe(GEN_CONFIG_MEDIA_TYPE)
  expect(manifest.layers).toHaveLength(1)
  expect(manifest.annotations["org.creatifact.gen.task"]).toBe("image2image")
  expect(manifest.annotations["org.creatifact.gen.provider"]).toBe("zhipu")

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
  // url artifact: downloaded into the layer AND url kept for provenance
  expect(config.result.artifacts).toEqual([
    { name: "artifact-1.png", url: "https://cdn.test/a.png", mimeType: "image/png" },
    { name: "artifact-2.png", mimeType: "image/png" },
  ])

  // the layer is self-contained: both files carry their real bytes
  const layerBlob = await readFile(
    join(outputDir, "blobs", "sha256", manifest.layers[0].digest.slice(7)),
  )
  const { view } = await mergeImageLayers([layerBlob])
  expect(view.get("artifact-1.png")).toMatchObject({ type: "file", data: urlBytes })
  expect(view.get("artifact-2.png")).toMatchObject({
    type: "file",
    data: Buffer.from("png-bytes"),
  })

  await rm(tmp, { recursive: true, force: true })
})

test("validateGenSpec accepts promptRef provenance and rejects bad shapes", () => {
  expect(
    validateGenSpec(
      {
        task: "text2image",
        prompt: "x",
        promptRef: { name: "writer", digest: "sha256:ab", tag: "demo/p:v1" },
      },
      "m",
    ),
  ).toEqual({
    task: "text2image",
    prompt: "x",
    promptRef: { name: "writer", digest: "sha256:ab", tag: "demo/p:v1" },
  })
  expect(validateGenSpec({ task: "text2image", promptRef: { name: "w" } }, "m")).toEqual({
    task: "text2image",
    promptRef: { name: "w" },
  })
  expect(() => validateGenSpec({ task: "text2image", promptRef: "writer" }, "m")).toThrow(
    /gen\.promptRef/,
  )
  expect(() => validateGenSpec({ task: "text2image", promptRef: { digest: "" } }, "m")).toThrow(
    /gen\.promptRef\.digest/,
  )
})

test("validateGenSpec accepts inputRefs media provenance and rejects bad shapes", () => {
  const inputRefs = [
    { field: "images", index: 0, name: "img", digest: "sha256:cd", tag: "demo/i:v1" },
  ]
  expect(validateGenSpec({ task: "image2video", inputRefs }, "m")).toEqual({
    task: "image2video",
    inputRefs,
  })
  // scalar frame input: index omitted
  expect(
    validateGenSpec({ task: "frames2video", inputRefs: [{ field: "firstFrame", name: "f" }] }, "m"),
  ).toEqual({ task: "frames2video", inputRefs: [{ field: "firstFrame", name: "f" }] })
  expect(() =>
    validateGenSpec({ task: "image2video", inputRefs: [{ field: "prompt", name: "x" }] }, "m"),
  ).toThrow(/gen\.inputRefs\[0\]\.field/)
  expect(() => validateGenSpec({ task: "image2video", inputRefs: [] }, "m")).toThrow(
    /gen\.inputRefs/,
  )
  expect(() =>
    validateGenSpec(
      { task: "image2video", inputRefs: [{ field: "images", name: "x", index: -1 }] },
      "m",
    ),
  ).toThrow(/gen\.inputRefs\[0\]\.index/)
})

test("buildResultPackage degrades to a url-only record when the download fails", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "gen-pkg-"))
  const outputDir = join(tmp, "out")

  const built = await buildResultPackage({
    outputDir,
    tag: "org/result:1.0",
    fetchBytes: async (url) => {
      throw new Error(`HTTP 403 downloading ${url}`)
    },
    artifacts: [{ url: "https://cdn.test/expired.mp4", mimeType: "video/mp4" }],
    spec: { task: "text2video", provider: "demo" },
    createdAt: "2026-08-17T00:00:00.000Z",
  })

  // the paid-for result is preserved: url-only record, no layer, a warning
  expect(built.warnings).toHaveLength(1)
  expect(built.warnings[0]).toContain("https://cdn.test/expired.mp4")
  expect(built.warnings[0]).toContain("not self-contained")

  const index = JSON.parse(await readFile(join(outputDir, "index.json"), "utf8"))
  const manifest = JSON.parse(
    await readFile(join(outputDir, "blobs", "sha256", index.manifests[0].digest.slice(7)), "utf8"),
  )
  expect(manifest.layers).toEqual([])
  const config = JSON.parse(
    await readFile(join(outputDir, "blobs", "sha256", manifest.config.digest.slice(7)), "utf8"),
  )
  expect(config.result.artifacts).toEqual([
    { url: "https://cdn.test/expired.mp4", mimeType: "video/mp4" },
  ])

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

async function readManifestConfig(dir: string): Promise<{
  manifest: { layers: Array<{ digest: string }>; config: { digest: string } }
  config: { result: Record<string, unknown> }
}> {
  const index = JSON.parse(await readFile(join(dir, "index.json"), "utf8")) as {
    manifests: Array<{ digest: string }>
  }
  const manifest = JSON.parse(
    await readFile(
      join(dir, "blobs", "sha256", index.manifests[0]?.digest?.slice(7) ?? ""),
      "utf8",
    ),
  ) as { layers: Array<{ digest: string }>; config: { digest: string } }
  const config = JSON.parse(
    await readFile(join(dir, "blobs", "sha256", manifest.config.digest.slice(7)), "utf8"),
  ) as { result: Record<string, unknown> }
  return { manifest, config }
}

async function layerFileText(dir: string, layerDigest: string, name: string): Promise<string> {
  const blob = await readFile(join(dir, "blobs", "sha256", layerDigest.slice(7)))
  const { view } = await mergeImageLayers([blob])
  const entry = view.get(name)
  return entry !== undefined && entry.type === "file" ? entry.data.toString("utf8") : ""
}

test("buildResultPackage stages text and vector payloads as referenceable layer files", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "gen-pkg-"))

  const textDir = join(tmp, "text-out")
  await buildResultPackage({
    outputDir: textDir,
    tag: "org/copy:1",
    artifacts: [],
    spec: { task: "text2text", provider: "zhipu" },
    text: "a generated story",
    createdAt: "2026-08-17T00:00:00.000Z",
  })
  const { manifest: textManifest, config: textConfig } = await readManifestConfig(textDir)
  expect(textManifest.layers).toHaveLength(1)
  expect(await layerFileText(textDir, textManifest.layers[0]?.digest ?? "", "text.txt")).toBe(
    "a generated story",
  )
  // text is inlined in the config for readability; the file rides the layer
  expect(textConfig.result["text"]).toBe("a generated story")
  expect(textConfig.result["artifacts"]).toEqual([{ name: "text.txt", mimeType: "text/plain" }])

  const vecDir = join(tmp, "vec-out")
  await buildResultPackage({
    outputDir: vecDir,
    tag: "org/emb:1",
    artifacts: [],
    spec: { task: "embed", provider: "zhipu" },
    vectors: [
      [0.1, 0.2],
      [0.3, 0.4],
    ],
    dimensions: 2,
    createdAt: "2026-08-17T00:00:00.000Z",
  })
  const { manifest: vecManifest, config: vecConfig } = await readManifestConfig(vecDir)
  expect(await layerFileText(vecDir, vecManifest.layers[0]?.digest ?? "", "vectors.json")).toBe(
    JSON.stringify(
      [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
      null,
      2,
    ),
  )
  // vectors stay out of the config (size); dimensions records the shape
  expect(vecConfig.result["vectors"]).toBeUndefined()
  expect(vecConfig.result["dimensions"]).toBe(2)
  expect(vecConfig.result["artifacts"]).toEqual([
    { name: "vectors.json", mimeType: "application/json" },
  ])

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
