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

import { checkBlobExists, uploadBlob } from "../push"
import { vi } from "vitest"

test("checkBlobExists returns true when blob exists (200)", async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
  vi.stubGlobal("fetch", fetchMock)

  const exists = await checkBlobExists(
    "http://localhost:5000",
    "myrepo",
    "sha256:abc",
    {},
  )
  expect(exists).toBe(true)
  expect(fetchMock).toHaveBeenCalledWith(
    "http://localhost:5000/v2/myrepo/blobs/sha256:abc",
    expect.objectContaining({ method: "HEAD" }),
  )

  vi.unstubAllGlobals()
})

test("checkBlobExists returns false when blob not found (404)", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }))

  const exists = await checkBlobExists("http://localhost:5000", "myrepo", "sha256:abc", {})
  expect(exists).toBe(false)

  vi.unstubAllGlobals()
})

test("uploadBlob does POST then PUT with blob data", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({
      ok: true,
      status: 202,
      headers: { get: () => "http://localhost:5000/v2/myrepo/blobs/uploads/uuid-123" },
    })
    .mockResolvedValueOnce({ ok: true, status: 201 })

  vi.stubGlobal("fetch", fetchMock)

  const blobData = Buffer.from("test content")
  await uploadBlob("http://localhost:5000", "myrepo", "sha256:abc", blobData, {})

  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(fetchMock).toHaveBeenNthCalledWith(
    1,
    "http://localhost:5000/v2/myrepo/blobs/uploads/",
    expect.objectContaining({ method: "POST" }),
  )
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    "http://localhost:5000/v2/myrepo/blobs/uploads/uuid-123?digest=sha256:abc",
    expect.objectContaining({
      method: "PUT",
      body: blobData,
    }),
  )

  vi.unstubAllGlobals()
})

test("uploadBlob throws when POST fails", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }))

  await expect(
    uploadBlob("http://localhost:5000", "myrepo", "sha256:abc", Buffer.from("x"), {}),
  ).rejects.toThrow("initiate upload")

  vi.unstubAllGlobals()
})

import { pushManifest } from "../push"

test("pushManifest PUTs manifest to correct URL", async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201 })
  vi.stubGlobal("fetch", fetchMock)

  const manifestData = Buffer.from('{"schemaVersion":2}')
  await pushManifest(
    "http://localhost:5000",
    "myrepo",
    "1.0",
    manifestData,
    "application/vnd.oci.image.manifest.v1+json",
    {},
  )

  expect(fetchMock).toHaveBeenCalledWith(
    "http://localhost:5000/v2/myrepo/manifests/1.0",
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/vnd.oci.image.manifest.v1+json",
      },
      body: manifestData,
    },
  )

  vi.unstubAllGlobals()
})

test("pushManifest throws on failure", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve("bad request"),
    }),
  )

  await expect(
    pushManifest(
      "http://localhost:5000",
      "myrepo",
      "1.0",
      Buffer.from("{}"),
      "application/vnd.oci.image.manifest.v1+json",
      {},
    ),
  ).rejects.toThrow("400")

  vi.unstubAllGlobals()
})
