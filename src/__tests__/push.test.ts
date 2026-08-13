import { parseRef, readOciLayout } from "../push"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("parseRef parses registry with port + repo + tag", () => {
  const result = parseRef("localhost:5000/myrepo:1.0")
  expect(result).toEqual({ registry: "localhost:5000", repository: "myrepo", tag: "1.0" })
})

test("parseRef parses registry without port + nested repo", () => {
  const result = parseRef("ghcr.io/user/repo:v2")
  expect(result).toEqual({ registry: "ghcr.io", repository: "user/repo", tag: "v2" })
})

test("parseRef defaults to docker.io when no registry host", () => {
  const result = parseRef("myrepo:1.0")
  expect(result).toEqual({ registry: "docker.io", repository: "myrepo", tag: "1.0" })
})

test("parseRef defaults tag to latest when missing", () => {
  const result = parseRef("localhost:5000/myrepo")
  expect(result).toEqual({ registry: "localhost:5000", repository: "myrepo", tag: "latest" })
})

test("parseRef handles docker.io with path", () => {
  const result = parseRef("docker.io/library/nginx:1.25")
  expect(result).toEqual({ registry: "docker.io", repository: "library/nginx", tag: "1.25" })
})

test("parseRef handles localhost without port", () => {
  const result = parseRef("localhost/myrepo:tag")
  expect(result).toEqual({ registry: "localhost", repository: "myrepo", tag: "tag" })
})

function sha256hex(data: string): string {
  return createHash("sha256").update(data).digest("hex")
}

test("readOciLayout reads index.json and manifest blob", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "push-test-"))
  const blobsDir = join(tmp, "blobs", "sha256")
  await mkdir(blobsDir, { recursive: true })

  const configData = "{}"
  const configDigest = `sha256:${sha256hex(configData)}`
  const layerData = "fake-layer"
  const layerDigest = `sha256:${sha256hex(layerData)}`
  const manifestObj = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.empty.v1+json", digest: configDigest, size: 2 },
    layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: layerDigest, size: 10 }],
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
        annotations: { "org.opencontainers.image.ref.name": "test:1.0" },
      },
    ],
  }
  await writeFile(join(tmp, "index.json"), JSON.stringify(index))
  await writeFile(join(tmp, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }))

  const layout = await readOciLayout(tmp)

  expect(layout.manifestDescriptor.digest).toBe(manifestDigest)
  expect(layout.manifest.config.digest).toBe(configDigest)
  expect(layout.manifest.layers[0]?.digest).toBe(layerDigest)
  expect(layout.refName).toBe("test:1.0")

  const configBlob = layout.blobs.get(configDigest)
  expect(configBlob?.toString()).toBe(configData)
  const layerBlob = layout.blobs.get(layerDigest)
  expect(layerBlob?.toString()).toBe(layerData)

  await rm(tmp, { recursive: true })
})
