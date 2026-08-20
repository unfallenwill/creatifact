import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable, Writable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createGzip, gunzipSync } from "node:zlib"
import { extract, pack } from "tar-stream"
import {
  buildManifest,
  mergeOptions,
  type OCIDescriptor,
  type ParsedArgs,
  parseBuildArgs,
  resolveImageSource,
  runBuild,
  runBuildFromArgs,
} from "../build"

const CONFIG: OCIDescriptor = {
  mediaType: "application/vnd.oci.image.config.v1+json",
  digest: "sha256:abc",
  size: 2,
}

const LAYER: OCIDescriptor = {
  mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
  digest: "sha256:def",
  size: 100,
}

function emptyCli(): ParsedArgs {
  return { annotations: {}, passwordStdin: false, plainHttp: false }
}

test("buildManifest produces valid OCI manifest with annotations", () => {
  const annotations = { "org.creatifact.platform": "CUDA" }

  const manifest = buildManifest(CONFIG, [LAYER], annotations)

  expect(manifest.schemaVersion).toBe(2)
  expect(manifest.mediaType).toBe("application/vnd.oci.image.manifest.v1+json")
  expect(manifest.config).toEqual(CONFIG)
  expect(manifest.layers).toEqual([LAYER])
  expect(manifest.annotations).toEqual(annotations)
})

test("buildManifest supports multiple layers and omits empty annotations", () => {
  const manifest = buildManifest(CONFIG, [LAYER, LAYER], {})
  expect(manifest.layers).toHaveLength(2)
  expect(manifest.annotations).toBeUndefined()
})

test("parseBuildArgs parses all flags", () => {
  const result = parseBuildArgs([
    "--dir",
    "./assets",
    "-t",
    "org/myapp:1.0.0",
    "-o",
    "./out",
    "-f",
    "./creatifact-build.json",
    "--annotation",
    "a=1",
    "--annotation",
    "b=2",
    "--username",
    "user",
    "--password",
    "secret",
    "--password-stdin",
    "--plain-http",
  ])

  expect(result.dir).toBe("./assets")
  expect(result.tag).toBe("org/myapp:1.0.0")
  expect(result.output).toBe("./out")
  expect(result.file).toBe("./creatifact-build.json")
  expect(result.annotations).toEqual({ a: "1", b: "2" })
  expect(result.username).toBe("user")
  expect(result.password).toBe("secret")
  expect(result.passwordStdin).toBe(true)
  expect(result.plainHttp).toBe(true)
})

test("parseBuildArgs rejects missing values and unknown flags", () => {
  expect(() => parseBuildArgs(["--dir"])).toThrow(/--dir/)
  expect(() => parseBuildArgs(["--unknown", "--dir", "x"])).toThrow(/unknown option/)
})

test("mergeOptions requires tag from CLI only", () => {
  expect(() => mergeOptions(emptyCli(), {})).toThrow("--tag is required")
  expect(() => mergeOptions(emptyCli(), { assets: "./a" })).toThrow("--tag is required")
  expect(() => mergeOptions({ ...emptyCli(), tag: "invalid" }, {})).toThrow("repo:tag")
})

test("mergeOptions CLI dir overrides manifest assets", () => {
  const cli = { ...emptyCli(), tag: "x:1", dir: "./cli-dir" }
  const opts = mergeOptions(cli, { assets: "./manifest-dir" })
  expect(opts.assetsDir).toBe("./cli-dir")
})

test("mergeOptions assets fall back to manifest and may be absent", () => {
  const withAssets = mergeOptions({ ...emptyCli(), tag: "x:1" }, { assets: "./a" })
  expect(withAssets.assetsDir).toBe("./a")

  const noAssets = mergeOptions({ ...emptyCli(), tag: "x:1" }, {})
  expect(noAssets.assetsDir).toBeUndefined()
})

test("mergeOptions normalizes from and merges annotations", () => {
  const opts = mergeOptions(
    { ...emptyCli(), tag: "x:1", annotations: { a: "cli" } },
    {
      from: "localhost:5000/base:1.0",
      annotations: { a: "desc", b: "desc" },
    },
  )
  expect(opts.from).toEqual(["localhost:5000/base:1.0"])
  expect(opts.annotations).toEqual({ a: "cli", b: "desc" })
})

test("mergeOptions defaults output and empty lists", () => {
  const opts = mergeOptions({ ...emptyCli(), tag: "x:1" }, {})
  expect(opts.output).toBeUndefined() // default resolved in runBuild (managed layouts dir)
  expect(opts.from).toEqual([])
  expect(opts.copy).toEqual([])
})

test("mergeOptions forwards gen from manifest", () => {
  const opts = mergeOptions({ ...emptyCli(), tag: "x:1" }, { gen: { task: "text2image" } })
  expect(opts.gen).toEqual({ task: "text2image" })
  expect(mergeOptions({ ...emptyCli(), tag: "x:1" }, {}).gen).toBeUndefined()
})

test("mergeOptions forwards auth options", () => {
  const opts = mergeOptions(
    { ...emptyCli(), tag: "x:1", username: "u", password: "p", plainHttp: true },
    {},
  )
  expect(opts.username).toBe("u")
  expect(opts.password).toBe("p")
  expect(opts.plainHttp).toBe(true)
})

test("resolveImageSource reads local layout when path exists", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "build-test-"))
  await setupLayout(tmp)

  const image = await resolveImageSource(tmp, process.cwd(), {
    plainHttp: false,
    username: undefined,
    password: undefined,
  })
  expect(image.manifest.layers).toHaveLength(1)
  expect(image.refName).toBe("org/base:1.0.0")

  await rm(tmp, { recursive: true })
})

test("resolveImageSource throws for missing local path", async () => {
  await expect(
    resolveImageSource("./nope-layout", process.cwd(), {
      plainHttp: false,
      username: undefined,
      password: undefined,
    }),
  ).rejects.toThrow("not found")
})

test("resolveImageSource fetches registry refs", async () => {
  const layerData = "layer-content"
  const layerDigest = sha256hex(layerData)
  const configData = "{}"
  const configDigest = sha256hex(configData)
  const manifestObj = {
    schemaVersion: 2 as const,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: {
      mediaType: "application/vnd.oci.empty.v1+json",
      digest: `sha256:${configDigest}`,
      size: 2,
    },
    layers: [
      {
        mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
        digest: `sha256:${layerDigest}`,
        size: 13,
      },
    ],
  }
  const manifestData = JSON.stringify(manifestObj)

  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => null } })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => "application/vnd.oci.image.manifest.v1+json" },
      text: () => Promise.resolve(manifestData),
    })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(Buffer.from(configData)),
    })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(Buffer.from(layerData)),
    })
  vi.stubGlobal("fetch", fetchMock)

  try {
    const image = await resolveImageSource("localhost:5000/test:1.0", process.cwd(), {
      plainHttp: true,
      username: undefined,
      password: undefined,
    })
    expect(image.blobs.get(`sha256:${layerDigest}`)?.toString()).toBe(layerData)
  } finally {
    vi.unstubAllGlobals()
  }
})

test("runBuild produces an empty image with no sources", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "build-test-"))
  const outputDir = join(tmp, "out")

  await runBuild({
    tag: "org/empty:1.0.0",
    assetsDir: undefined,
    output: outputDir,
    annotations: {},
    from: [],
    copy: [],
    plainHttp: false,
    username: undefined,
    password: undefined,
  })

  const index = JSON.parse(await readFile(join(outputDir, "index.json"), "utf8"))
  const manifest = JSON.parse(
    await readFile(join(outputDir, "blobs", "sha256", index.manifests[0].digest.slice(7)), "utf8"),
  )
  expect(manifest.layers).toEqual([])
  expect(manifest.config.mediaType).toBe("application/vnd.oci.empty.v1+json")

  await rm(tmp, { recursive: true })
})

test("runBuild --plan writes a gen recipe into the config blob without executing", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "build-test-"))
  const outputDir = join(tmp, "out")

  await runBuild({
    tag: "org/gen:1.0.0",
    assetsDir: undefined,
    output: outputDir,
    annotations: {},
    from: [],
    copy: [],
    plan: true,
    gen: {
      task: "image2image",
      provider: "zhipu",
      model: "cogview-4",
      options: { size: "1024x1024" },
    },
    plainHttp: false,
    username: undefined,
    password: undefined,
  })

  const index = JSON.parse(await readFile(join(outputDir, "index.json"), "utf8"))
  const manifest = JSON.parse(
    await readFile(join(outputDir, "blobs", "sha256", index.manifests[0].digest.slice(7)), "utf8"),
  )
  expect(manifest.config.mediaType).toBe("application/vnd.creatifact.gen.v1+json")
  const config = JSON.parse(
    await readFile(join(outputDir, "blobs", "sha256", manifest.config.digest.slice(7)), "utf8"),
  )
  expect(config).toEqual({
    schemaVersion: 1,
    gen: {
      task: "image2image",
      provider: "zhipu",
      model: "cogview-4",
      options: { size: "1024x1024" },
    },
  })

  await rm(tmp, { recursive: true })
})

test("runBuild packs assets as the top layer", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "build-test-"))
  const assetsDir = join(tmp, "assets")
  const outputDir = join(tmp, "out")
  await mkdir(assetsDir, { recursive: true })
  await writeFile(join(assetsDir, "asset.txt"), "asset data")

  await runBuild({
    tag: "org/pkg:1.0.0",
    assetsDir,
    output: outputDir,
    annotations: { "org.creatifact.platform": "CUDA" },
    from: [],
    copy: [],
    plainHttp: false,
    username: undefined,
    password: undefined,
  })

  const index = JSON.parse(await readFile(join(outputDir, "index.json"), "utf8"))
  expect(index.manifests[0].annotations["org.opencontainers.image.ref.name"]).toBe("org/pkg:1.0.0")
  const manifest = JSON.parse(
    await readFile(join(outputDir, "blobs", "sha256", index.manifests[0].digest.slice(7)), "utf8"),
  )
  expect(manifest.layers).toHaveLength(1)
  expect(manifest.annotations).toEqual({ "org.creatifact.platform": "CUDA" })

  await rm(tmp, { recursive: true })
})

test("runBuild inherits layers from a local layout", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "build-test-"))
  const sourceDir = join(tmp, "source")
  const outputDir = join(tmp, "out")
  await setupLayout(sourceDir)

  await runBuild({
    tag: "org/pkg:1.0.0",
    assetsDir: undefined,
    output: outputDir,
    annotations: {},
    from: [sourceDir],
    copy: [],
    plainHttp: false,
    username: undefined,
    password: undefined,
  })

  const index = JSON.parse(await readFile(join(outputDir, "index.json"), "utf8"))
  const manifest = JSON.parse(
    await readFile(join(outputDir, "blobs", "sha256", index.manifests[0].digest.slice(7)), "utf8"),
  )
  expect(manifest.layers).toHaveLength(1)
  const layerDigest = manifest.layers[0].digest
  expect(await readFile(join(outputDir, "blobs", "sha256", layerDigest.slice(7)))).toBeTruthy()

  await rm(tmp, { recursive: true })
})

test("runBuild throws when assets dir is missing or empty", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "build-test-"))
  const emptyDir = join(tmp, "empty")
  await mkdir(emptyDir, { recursive: true })

  await expect(
    runBuild({
      tag: "x:1",
      assetsDir: join(tmp, "nope"),
      output: join(tmp, "o1"),
      annotations: {},
      from: [],
      copy: [],
      plainHttp: false,
      username: undefined,
      password: undefined,
    }),
  ).rejects.toThrow("does not exist")
  await expect(
    runBuild({
      tag: "x:1",
      assetsDir: emptyDir,
      output: join(tmp, "o2"),
      annotations: {},
      from: [],
      copy: [],
      plainHttp: false,
      username: undefined,
      password: undefined,
    }),
  ).rejects.toThrow("is empty")

  await rm(tmp, { recursive: true })
})

test("runBuild throws when output dir exists and is not empty", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "build-test-"))
  const outputDir = join(tmp, "out")
  await mkdir(outputDir, { recursive: true })
  await writeFile(join(outputDir, "blocking.txt"), "x")

  await expect(
    runBuild({
      tag: "x:1",
      assetsDir: undefined,
      output: outputDir,
      annotations: {},
      from: [],
      copy: [],
      plainHttp: false,
      username: undefined,
      password: undefined,
    }),
  ).rejects.toThrow("already exists")

  await rm(tmp, { recursive: true })
})

test("runBuild extracts copy paths into a new layer", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "build-test-"))
  const sourceDir = join(tmp, "source")
  const outputDir = join(tmp, "out")
  await setupRealLayout(sourceDir, [
    { name: "libs/x.so", data: "x" },
    { name: "libs/y.so", data: "y" },
    { name: "bin/tool", data: "t" },
  ])

  await runBuild({
    tag: "org/pkg:1.0.0",
    assetsDir: undefined,
    output: outputDir,
    annotations: {},
    from: [],
    copy: [{ from: sourceDir, paths: ["libs/x.so"] }],
    plainHttp: false,
    username: undefined,
    password: undefined,
  })

  const index = JSON.parse(await readFile(join(outputDir, "index.json"), "utf8"))
  const manifest = JSON.parse(
    await readFile(join(outputDir, "blobs", "sha256", index.manifests[0].digest.slice(7)), "utf8"),
  )
  expect(manifest.layers).toHaveLength(1)

  const layerBlob = await readFile(
    join(outputDir, "blobs", "sha256", manifest.layers[0].digest.slice(7)),
  )
  const gunzipped = gunzipSync(layerBlob)
  const entries = await extractTarEntries(gunzipped)
  expect(entries.has("libs/x.so")).toBe(true)
  expect(entries.has("libs/y.so")).toBe(false)

  await rm(tmp, { recursive: true })
})

test("runBuild packs dotfiles from the assets dir into the layer", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "build-test-"))
  const assetsDir = join(tmp, "assets")
  const outputDir = join(tmp, "out")
  await mkdir(assetsDir, { recursive: true })
  await writeFile(join(assetsDir, ".hidden"), "h")
  await writeFile(join(assetsDir, "visible.txt"), "v")
  await mkdir(join(assetsDir, "sub"))
  await writeFile(join(assetsDir, "sub", ".gitignore"), "g")

  await runBuild({
    tag: "org/dot:1.0.0",
    assetsDir,
    output: outputDir,
    annotations: {},
    from: [],
    copy: [],
    plainHttp: false,
    username: undefined,
    password: undefined,
  })

  const index = JSON.parse(await readFile(join(outputDir, "index.json"), "utf8"))
  const manifest = JSON.parse(
    await readFile(join(outputDir, "blobs", "sha256", index.manifests[0].digest.slice(7)), "utf8"),
  )
  const layerBlob = await readFile(
    join(outputDir, "blobs", "sha256", manifest.layers[0].digest.slice(7)),
  )
  const entries = await extractTarEntries(gunzipSync(layerBlob))
  expect([...entries.keys()].sort()).toEqual([".hidden", "sub/.gitignore", "visible.txt"])

  await rm(tmp, { recursive: true })
})

test("runBuild throws when copy path has no match", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "build-test-"))
  const sourceDir = join(tmp, "source")
  await setupRealLayout(sourceDir, [{ name: "a.txt", data: "x" }])

  await expect(
    runBuild({
      tag: "x:1",
      assetsDir: undefined,
      output: join(tmp, "out"),
      annotations: {},
      from: [],
      copy: [{ from: sourceDir, paths: ["nope"] }],
      plainHttp: false,
      username: undefined,
      password: undefined,
    }),
  ).rejects.toThrow("not found")

  await rm(tmp, { recursive: true })
})

test("runBuild combines from, copy, and assets in layer order", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "build-test-"))
  const baseDir = join(tmp, "base")
  const copySourceDir = join(tmp, "copy-source")
  const assetsDir = join(tmp, "assets")
  const outputDir = join(tmp, "out")
  await setupRealLayout(baseDir, [{ name: "base.txt", data: "base" }])
  await setupRealLayout(copySourceDir, [{ name: "copied.txt", data: "copied" }])
  await mkdir(assetsDir, { recursive: true })
  await writeFile(join(assetsDir, "local.txt"), "local")

  await runBuild({
    tag: "org/pkg:1.0.0",
    assetsDir,
    output: outputDir,
    annotations: {},
    from: [baseDir],
    copy: [{ from: copySourceDir, paths: ["copied.txt"] }],
    plainHttp: false,
    username: undefined,
    password: undefined,
  })

  const index = JSON.parse(await readFile(join(outputDir, "index.json"), "utf8"))
  const manifest = JSON.parse(
    await readFile(join(outputDir, "blobs", "sha256", index.manifests[0].digest.slice(7)), "utf8"),
  )
  expect(manifest.layers).toHaveLength(3)
  // from layer is referenced as-is (same digest as source)
  expect(manifest.layers[0].digest).toMatch(/^sha256:/)

  await rm(tmp, { recursive: true })
})

test("runBuildFromArgs parses CLI and manifest together", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "build-test-"))
  const assetsDir = join(tmp, "assets")
  const outputDir = join(tmp, "out")
  await mkdir(assetsDir, { recursive: true })
  await writeFile(join(assetsDir, "f.txt"), "data")
  const manifestPath = join(tmp, "creatifact-build.json")
  await writeFile(manifestPath, JSON.stringify({ assets: "./assets", annotations: { a: "1" } }))

  await runBuildFromArgs(["-f", manifestPath, "-t", "org/pkg:1.0.0", "-o", outputDir])

  const index = JSON.parse(await readFile(join(outputDir, "index.json"), "utf8"))
  expect(index.manifests[0].annotations["org.opencontainers.image.ref.name"]).toBe("org/pkg:1.0.0")
  const manifest = JSON.parse(
    await readFile(join(outputDir, "blobs", "sha256", index.manifests[0].digest.slice(7)), "utf8"),
  )
  expect(manifest.layers).toHaveLength(1)
  expect(manifest.annotations).toEqual({ a: "1" })

  await rm(tmp, { recursive: true })
})

function sha256hex(data: string): string {
  return createHash("sha256").update(data).digest("hex")
}

async function setupLayout(dir: string): Promise<void> {
  const blobsDir = join(dir, "blobs", "sha256")
  await mkdir(blobsDir, { recursive: true })

  const configData = "{}"
  const configDigest = `sha256:${sha256hex(configData)}`
  const layerData = "layer-content"
  const layerDigest = `sha256:${sha256hex(layerData)}`
  const manifestObj = {
    schemaVersion: 2 as const,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.empty.v1+json", digest: configDigest, size: 2 },
    layers: [
      { mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: layerDigest, size: 13 },
    ],
  }
  const manifestData = JSON.stringify(manifestObj)
  const manifestDigest = `sha256:${sha256hex(manifestData)}`

  await writeFile(join(blobsDir, configDigest.slice(7)), configData)
  await writeFile(join(blobsDir, layerDigest.slice(7)), layerData)
  await writeFile(join(blobsDir, manifestDigest.slice(7)), manifestData)

  const index = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: manifestDigest,
        size: manifestData.length,
        annotations: { "org.opencontainers.image.ref.name": "org/base:1.0.0" },
      },
    ],
  }
  await writeFile(join(dir, "index.json"), JSON.stringify(index))
  await writeFile(join(dir, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }))
}

async function makeLayerTar(entries: Array<{ name: string; data: string }>): Promise<Buffer> {
  const tarPack = pack()
  for (const e of entries) {
    tarPack.entry({ name: e.name, size: e.data.length }, e.data)
  }
  tarPack.finalize()

  const chunks: Buffer[] = []
  const collector = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
  })
  await pipeline(tarPack, createGzip(), collector)
  return Buffer.concat(chunks)
}

async function extractTarEntries(tarData: Buffer): Promise<Map<string, string>> {
  const entries = new Map<string, string>()
  const extractor = extract()
  const done = pipeline(Readable.from([tarData]), extractor)
  for await (const entry of extractor) {
    const chunks: Buffer[] = []
    for await (const chunk of entry) chunks.push(Buffer.from(chunk))
    entries.set(entry.header.name, Buffer.concat(chunks).toString("utf8"))
  }
  await done
  return entries
}

async function setupRealLayout(
  dir: string,
  files: Array<{ name: string; data: string }>,
): Promise<void> {
  const blobsDir = join(dir, "blobs", "sha256")
  await mkdir(blobsDir, { recursive: true })

  const configData = "{}"
  const configDigest = `sha256:${sha256hex(configData)}`
  const layerData = await makeLayerTar(files)
  const realLayerDigest = `sha256:${createHash("sha256").update(layerData).digest("hex")}`
  const manifestObj = {
    schemaVersion: 2 as const,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: {
      mediaType: "application/vnd.oci.empty.v1+json",
      digest: configDigest,
      size: 2,
    },
    layers: [
      {
        mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
        digest: realLayerDigest,
        size: layerData.length,
      },
    ],
  }
  const manifestData = JSON.stringify(manifestObj)
  const manifestDigest = `sha256:${sha256hex(manifestData)}`

  await writeFile(join(blobsDir, configDigest.slice(7)), configData)
  await writeFile(join(blobsDir, realLayerDigest.slice(7)), layerData)
  await writeFile(join(blobsDir, manifestDigest.slice(7)), manifestData)

  const index = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: manifestDigest,
        size: manifestData.length,
        annotations: { "org.opencontainers.image.ref.name": "org/base:1.0.0" },
      },
    ],
  }
  await writeFile(join(dir, "index.json"), JSON.stringify(index))
  await writeFile(join(dir, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }))
}
