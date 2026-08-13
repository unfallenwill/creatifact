import { buildManifest, type OCIDescriptor } from "../pack"

test("buildManifest produces valid OCI manifest with annotations", () => {
  const config: OCIDescriptor = {
    mediaType: "application/vnd.oci.image.config.v1+json",
    digest: "sha256:abc",
    size: 2,
  }
  const layer: OCIDescriptor = {
    mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
    digest: "sha256:def",
    size: 100,
  }
  const annotations = { "org.openmm.platform": "CUDA" }

  const manifest = buildManifest(config, layer, annotations)

  expect(manifest.schemaVersion).toBe(2)
  expect(manifest.mediaType).toBe("application/vnd.oci.image.manifest.v1+json")
  expect(manifest.config).toEqual(config)
  expect(manifest.layers).toEqual([layer])
  expect(manifest.annotations).toEqual(annotations)
})

test("buildManifest omits annotations when empty", () => {
  const config: OCIDescriptor = {
    mediaType: "application/vnd.oci.image.config.v1+json",
    digest: "sha256:abc",
    size: 2,
  }
  const layer: OCIDescriptor = {
    mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
    digest: "sha256:def",
    size: 100,
  }

  const manifest = buildManifest(config, layer, {})

  expect(manifest.annotations).toBeUndefined()
})

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { gunzipSync } from "node:zlib"
import { extract } from "tar-stream"
import { createLayerTarball, writeBlob } from "../pack"

test("writeBlob writes content and returns correct descriptor", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "oci-test-"))
  const blobsDir = join(tmp, "blobs", "sha256")
  await mkdir(blobsDir, { recursive: true })

  const content = Buffer.from("{}")
  const desc = await writeBlob(content, blobsDir, "application/vnd.oci.image.config.v1+json")

  expect(desc.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
  expect(desc.size).toBe(content.length)
  expect(desc.mediaType).toBe("application/vnd.oci.image.config.v1+json")

  const written = await readFile(join(blobsDir, desc.digest.slice(7)))
  expect(written).toEqual(content)

  await rm(tmp, { recursive: true })
})

test("createLayerTarball packs directory into tar.gz blob", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "oci-test-"))
  const srcDir = join(tmp, "src")
  const blobsDir = join(tmp, "blobs", "sha256")
  await mkdir(srcDir, { recursive: true })
  await mkdir(blobsDir, { recursive: true })
  await mkdir(join(srcDir, "sub"), { recursive: true })

  await writeFile(join(srcDir, "hello.txt"), "hello world")
  await writeFile(join(srcDir, "sub", "nested.txt"), "nested content")

  const desc = await createLayerTarball(srcDir, blobsDir)

  expect(desc.mediaType).toBe("application/vnd.oci.image.layer.v1.tar+gzip")
  expect(desc.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
  expect(desc.size).toBeGreaterThan(0)

  const blobData = await readFile(join(blobsDir, desc.digest.slice(7)))
  const entries = await extractTarEntries(blobData)
  expect(Object.keys(entries).sort()).toEqual(["hello.txt", "sub/nested.txt"])
  expect(entries["hello.txt"]?.toString()).toBe("hello world")
  expect(entries["sub/nested.txt"]?.toString()).toBe("nested content")

  await rm(tmp, { recursive: true })
})

async function extractTarEntries(gzipData: Buffer): Promise<Record<string, Buffer>> {
  const unzipped = gunzipSync(gzipData)
  const entries: Record<string, Buffer> = {}
  return new Promise((resolve, reject) => {
    const ex = extract()
    ex.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = []
      stream.on("data", (chunk: Buffer) => chunks.push(chunk))
      stream.on("end", () => {
        if (header.name) {
          entries[header.name] = Buffer.concat(chunks)
        }
        next()
      })
    })
    ex.on("finish", () => resolve(entries))
    ex.on("error", reject)
    Readable.from([unzipped]).pipe(ex)
  })
}

import { existsSync } from "node:fs"
import { writeOciLayout } from "../pack"

test("writeOciLayout writes oci-layout and index.json", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "oci-test-"))
  const manifestDescriptor = {
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest: "sha256:abc123",
    size: 42,
  }

  await writeOciLayout(tmp, manifestDescriptor, "org/plugins:1.0.0")

  expect(existsSync(join(tmp, "oci-layout"))).toBe(true)
  expect(existsSync(join(tmp, "index.json"))).toBe(true)

  const layout = JSON.parse(await readFile(join(tmp, "oci-layout"), "utf8"))
  expect(layout).toEqual({ imageLayoutVersion: "1.0.0" })

  const index = JSON.parse(await readFile(join(tmp, "index.json"), "utf8"))
  expect(index.schemaVersion).toBe(2)
  expect(index.manifests).toHaveLength(1)
  expect(index.manifests[0]).toEqual({
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest: "sha256:abc123",
    size: 42,
    annotations: { "org.opencontainers.image.ref.name": "org/plugins:1.0.0" },
  })

  await rm(tmp, { recursive: true })
})

import { loadDescriptionFile, mergeOptions, parsePackArgs } from "../pack"

test("parsePackArgs parses all flags", () => {
  const result = parsePackArgs([
    "--dir",
    "./plugins",
    "--name",
    "org/plugins:1.0.0",
    "-o",
    "./out",
    "-f",
    "./openmm-pack.json",
    "--annotation",
    "org.openmm.platform=CUDA",
    "--annotation",
    "org.openmm.arch=arm64",
  ])

  expect(result.dir).toBe("./plugins")
  expect(result.name).toBe("org/plugins:1.0.0")
  expect(result.output).toBe("./out")
  expect(result.file).toBe("./openmm-pack.json")
  expect(result.annotations).toEqual({
    "org.openmm.platform": "CUDA",
    "org.openmm.arch": "arm64",
  })
})

test("parsePackArgs handles missing values gracefully", () => {
  const result = parsePackArgs(["--dir"])
  expect(result.dir).toBeUndefined()
})

test("parsePackArgs ignores unknown flags", () => {
  const result = parsePackArgs(["--unknown", "--dir", "x"])
  expect(result.dir).toBe("x")
})

test("mergeOptions CLI overrides description file", () => {
  const cli = parsePackArgs(["--name", "cli:1.0", "--dir", "./cli-dir"])
  const desc = { name: "desc:2.0", dir: "./desc-dir", annotations: { a: "1" } }

  const opts = mergeOptions(cli, desc)

  expect(opts.name).toBe("cli:1.0")
  expect(opts.dir).toBe("./cli-dir")
})

test("mergeOptions annotations merge with CLI priority", () => {
  const cli = parsePackArgs(["--name", "x:1", "--annotation", "a=cli"])
  const desc = { annotations: { a: "desc", b: "desc" } }

  const opts = mergeOptions(cli, desc)

  expect(opts.annotations).toEqual({ a: "cli", b: "desc" })
})

test("mergeOptions applies defaults", () => {
  const cli = parsePackArgs(["--name", "x:1"])

  const opts = mergeOptions(cli, {})

  expect(opts.dir).toBe("./plugins")
  expect(opts.output).toBe("./oci-layout")
  expect(opts.annotations).toEqual({})
})

test("mergeOptions throws when name missing", () => {
  expect(() => mergeOptions({ annotations: {} }, {})).toThrow("--name")
})

test("mergeOptions throws when name has no colon", () => {
  expect(() => mergeOptions({ annotations: {} }, { name: "invalid" })).toThrow("repo:tag")
})

test("loadDescriptionFile returns empty when file missing", async () => {
  const result = await loadDescriptionFile("./nonexistent-file.json")
  expect(result).toEqual({})
})

test("loadDescriptionFile parses valid JSON", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "oci-test-"))
  const filePath = join(tmp, "desc.json")
  await writeFile(filePath, JSON.stringify({ name: "test:1.0", dir: "./data" }))

  const result = await loadDescriptionFile(filePath)

  expect(result.name).toBe("test:1.0")
  expect(result.dir).toBe("./data")

  await rm(tmp, { recursive: true })
})

test("loadDescriptionFile throws on invalid JSON", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "oci-test-"))
  const filePath = join(tmp, "desc.json")
  await writeFile(filePath, "{ invalid json }")

  await expect(loadDescriptionFile(filePath)).rejects.toThrow()

  await rm(tmp, { recursive: true })
})

import { runPack } from "../pack"

test("runPack produces complete OCI layout from directory", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "oci-test-"))
  const srcDir = join(tmp, "src")
  const outputDir = join(tmp, "output")
  await mkdir(srcDir, { recursive: true })
  await writeFile(join(srcDir, "plugin.txt"), "plugin data")

  await runPack({
    name: "org/plugins:1.0.0",
    dir: srcDir,
    output: outputDir,
    annotations: { "org.openmm.platform": "CUDA" },
  })

  expect(existsSync(join(outputDir, "oci-layout"))).toBe(true)
  expect(existsSync(join(outputDir, "index.json"))).toBe(true)

  const index = JSON.parse(await readFile(join(outputDir, "index.json"), "utf8"))
  expect(index.manifests[0].annotations["org.opencontainers.image.ref.name"]).toBe(
    "org/plugins:1.0.0",
  )

  const manifestDigest = index.manifests[0].digest
  const manifestPath = join(outputDir, "blobs", "sha256", manifestDigest.slice(7))
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))

  expect(manifest.schemaVersion).toBe(2)
  expect(manifest.config.mediaType).toBe("application/vnd.oci.image.config.v1+json")
  expect(manifest.layers).toHaveLength(1)
  expect(manifest.layers[0].mediaType).toBe("application/vnd.oci.image.layer.v1.tar+gzip")
  expect(manifest.annotations).toEqual({ "org.openmm.platform": "CUDA" })

  const configPath = join(outputDir, "blobs", "sha256", manifest.config.digest.slice(7))
  const config = JSON.parse(await readFile(configPath, "utf8"))
  expect(config).toEqual({})

  await rm(tmp, { recursive: true })
})

test("runPack throws when dir does not exist", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "oci-test-"))
  await expect(
    runPack({ name: "x:1", dir: join(tmp, "nope"), output: join(tmp, "out"), annotations: {} }),
  ).rejects.toThrow()

  await rm(tmp, { recursive: true })
})

test("runPack throws when dir is empty", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "oci-test-"))
  const emptyDir = join(tmp, "empty")
  await mkdir(emptyDir, { recursive: true })

  await expect(
    runPack({ name: "x:1", dir: emptyDir, output: join(tmp, "out"), annotations: {} }),
  ).rejects.toThrow("empty")

  await rm(tmp, { recursive: true })
})

test("runPack throws when output dir exists and is not empty", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "oci-test-"))
  const srcDir = join(tmp, "src")
  const outputDir = join(tmp, "out")
  await mkdir(srcDir, { recursive: true })
  await mkdir(outputDir, { recursive: true })
  await writeFile(join(srcDir, "file.txt"), "data")
  await writeFile(join(outputDir, "existing.txt"), "blocking")

  await expect(
    runPack({ name: "x:1", dir: srcDir, output: outputDir, annotations: {} }),
  ).rejects.toThrow("already exists")

  await rm(tmp, { recursive: true })
})
