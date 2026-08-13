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

import { createLayerTarball, writeBlob } from "../pack"
import { gunzipSync } from "node:zlib"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { extract } from "tar-stream"

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

import { writeOciLayout } from "../pack"
import { existsSync } from "node:fs"

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
