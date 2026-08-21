import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseRef, readOciLayout } from "../push"

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

test("parseRef honors a caller-provided default registry", () => {
  expect(parseRef("myrepo:1.0", "localhost:5000")).toEqual({
    registry: "localhost:5000",
    repository: "myrepo",
    tag: "1.0",
  })
  // An explicit registry in the ref still wins over the default.
  expect(parseRef("ghcr.io/myrepo:1.0", "localhost:5000")).toEqual({
    registry: "ghcr.io",
    repository: "myrepo",
    tag: "1.0",
  })
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
    layers: [
      { mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: layerDigest, size: 10 },
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

import { vi } from "vitest"
import { checkBlobExists, uploadBlob } from "../push"

test("checkBlobExists returns true when blob exists (200)", async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
  vi.stubGlobal("fetch", fetchMock)

  const exists = await checkBlobExists("http://localhost:5000", "myrepo", "sha256:abc", {})
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
  const fetchMock = vi
    .fn()
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
      // uploadBlob wraps the Buffer in a plain Uint8Array view; vitest 4's
      // equals no longer treats Buffer and Uint8Array as interchangeable.
      body: new Uint8Array(blobData),
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

  expect(fetchMock).toHaveBeenCalledWith("http://localhost:5000/v2/myrepo/manifests/1.0", {
    method: "PUT",
    headers: {
      "Content-Type": "application/vnd.oci.image.manifest.v1+json",
    },
    body: expect.any(Uint8Array),
  })

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

import { parseAuthHeader, resolveAuth } from "../push"

test("parseAuthHeader extracts Bearer realm, service, scope", () => {
  const header = `Bearer realm="https://auth.example.com/token",service="registry.example.com",scope="repository:myrepo:push,pull"`
  const result = parseAuthHeader(header)
  expect(result).toEqual({
    scheme: "Bearer",
    params: {
      realm: "https://auth.example.com/token",
      service: "registry.example.com",
      scope: "repository:myrepo:push,pull",
    },
  })
})

test("parseAuthHeader handles Basic scheme", () => {
  const result = parseAuthHeader('Basic realm="Registry"')
  expect(result.scheme).toBe("Basic")
  expect(result.params).toEqual({ realm: "Registry" })
})

test("resolveAuth fetches Bearer token from realm", async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ token: "jwt-token-123" }),
  })
  vi.stubGlobal("fetch", fetchMock)

  const headers = await resolveAuth(
    `Bearer realm="https://auth.example.com/token",service="registry.example.com",scope="repository:myrepo:push"`,
    undefined,
  )

  expect(headers).toEqual({ Authorization: "Bearer jwt-token-123" })
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining("https://auth.example.com/token"),
    expect.objectContaining({ method: "GET" }),
  )
  const calledUrl = fetchMock.mock.calls[0]?.[0] as string
  expect(calledUrl).toContain("service=registry.example.com")
  expect(calledUrl).toContain("scope=repository%3Amyrepo%3Apush")

  vi.unstubAllGlobals()
})

test("resolveAuth sends Basic auth to token endpoint when credentials provided", async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ token: "jwt-token-456" }),
  })
  vi.stubGlobal("fetch", fetchMock)

  await resolveAuth(
    `Bearer realm="https://auth.example.com/token",service="registry.example.com",scope="repository:myrepo:push"`,
    { username: "user", password: "pass" },
  )

  expect(fetchMock).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: expect.stringContaining("Basic "),
      }),
    }),
  )

  vi.unstubAllGlobals()
})

test("resolveAuth uses access_token fallback", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: "fallback-token" }),
    }),
  )

  const headers = await resolveAuth(
    `Bearer realm="https://auth.example.com/token",service="r",scope="repository:x:push"`,
    undefined,
  )
  expect(headers).toEqual({ Authorization: "Bearer fallback-token" })

  vi.unstubAllGlobals()
})

test("resolveAuth returns Basic header for Basic scheme", async () => {
  const headers = await resolveAuth('Basic realm="Registry"', {
    username: "user",
    password: "pass",
  })
  expect(headers["Authorization"]).toMatch(/^Basic /)
})

test("resolveAuth throws when token fetch fails", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }))

  await expect(
    resolveAuth(
      `Bearer realm="https://auth.example.com/token",service="r",scope="repository:x:push"`,
      undefined,
    ),
  ).rejects.toThrow("token")

  vi.unstubAllGlobals()
})

import { parsePushArgs, runPush } from "../push"

test("parsePushArgs parses positional ref and flags", () => {
  const result = parsePushArgs([
    "localhost:5000/myrepo:1.0",
    "--layout",
    "./my-layout",
    "--username",
    "user",
    "--password",
    "secret",
    "--plain-http",
  ])
  expect(result.ref).toBe("localhost:5000/myrepo:1.0")
  expect(result.layout).toBe("./my-layout")
  expect(result.username).toBe("user")
  expect(result.password).toBe("secret")
  expect(result.plainHttp).toBe(true)
})

test("parsePushArgs applies defaults", () => {
  const result = parsePushArgs(["test:1.0"])
  expect(result.ref).toBe("test:1.0")
  expect(result.layout).toBeUndefined()
  expect(result.plainHttp).toBe(false)
})

test("parsePushArgs handles no positional arg", () => {
  const result = parsePushArgs(["--layout", "./x"])
  expect(result.ref).toBeUndefined()
})

async function setupTestLayout(tmp: string): Promise<void> {
  const blobsDir = join(tmp, "blobs", "sha256")
  await mkdir(blobsDir, { recursive: true })

  const configData = "{}"
  const configDigest = `sha256:${sha256hex(configData)}`
  const layerData = "layer-content"
  const layerDigest = `sha256:${sha256hex(layerData)}`
  const manifestObj = {
    schemaVersion: 2,
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
        annotations: { "org.opencontainers.image.ref.name": "localhost:5000/test:1.0" },
      },
    ],
  }
  await writeFile(join(tmp, "index.json"), JSON.stringify(index))
  await writeFile(join(tmp, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }))
}

test("runPush uploads blobs and manifest to registry", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "push-test-"))
  await setupTestLayout(tmp)

  const fetchMock = vi.fn()
  // Interleaved: probe → HEAD config → POST config → PUT config → HEAD layer → POST layer → PUT layer → PUT manifest
  fetchMock
    .mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => null } }) // probe
    .mockResolvedValueOnce({ ok: false, status: 404 }) // HEAD config → not exists
    .mockResolvedValueOnce({
      ok: true,
      status: 202,
      headers: { get: () => "http://localhost:5000/v2/test/blobs/uploads/uuid-1" },
    }) // POST config upload
    .mockResolvedValueOnce({ ok: true, status: 201 }) // PUT config upload
    .mockResolvedValueOnce({ ok: false, status: 404 }) // HEAD layer → not exists
    .mockResolvedValueOnce({
      ok: true,
      status: 202,
      headers: { get: () => "http://localhost:5000/v2/test/blobs/uploads/uuid-2" },
    }) // POST layer upload
    .mockResolvedValueOnce({ ok: true, status: 201 }) // PUT layer upload
    .mockResolvedValueOnce({ ok: true, status: 201 }) // PUT manifest

  vi.stubGlobal("fetch", fetchMock)

  try {
    await runPush({
      ref: "localhost:5000/test:1.0",
      layout: tmp,
      plainHttp: true,
      username: undefined,
      password: undefined,
    })

    // Should have made 8 requests (probe + 2 HEAD + 4 upload + manifest)
    expect(fetchMock).toHaveBeenCalledTimes(8)

    // Second call should be HEAD config blob
    const headCall = fetchMock.mock.calls[1]
    expect(headCall?.[0]).toContain("/v2/test/blobs/sha256:")
    expect(headCall?.[1]).toEqual(expect.objectContaining({ method: "HEAD" }))

    // Last call should be PUT manifest
    const lastCall = fetchMock.mock.calls[7]
    expect(lastCall?.[0]).toContain("/v2/test/manifests/1.0")
    expect(lastCall?.[1]).toEqual(expect.objectContaining({ method: "PUT" }))
  } finally {
    vi.unstubAllGlobals()
    await rm(tmp, { recursive: true })
  }
})

test("runPush skips existing blobs", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "push-test-"))
  await setupTestLayout(tmp)

  const fetchMock = vi.fn()
  // probe + both blobs exist → skip upload, only push manifest
  fetchMock
    .mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => null } }) // probe
    .mockResolvedValueOnce({ ok: true, status: 200 }) // HEAD config exists
    .mockResolvedValueOnce({ ok: true, status: 200 }) // HEAD layer exists
    .mockResolvedValueOnce({ ok: true, status: 201 }) // PUT manifest

  vi.stubGlobal("fetch", fetchMock)

  try {
    await runPush({
      ref: "localhost:5000/test:1.0",
      layout: tmp,
      plainHttp: true,
      username: undefined,
      password: undefined,
    })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  } finally {
    vi.unstubAllGlobals()
    await rm(tmp, { recursive: true })
  }
})

test("runPush uses ref from index.json when ref not specified", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "push-test-"))
  await setupTestLayout(tmp)

  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => null } }) // probe
    .mockResolvedValueOnce({ ok: true, status: 200 })
    .mockResolvedValueOnce({ ok: true, status: 200 })
    .mockResolvedValueOnce({ ok: true, status: 201 })

  vi.stubGlobal("fetch", fetchMock)

  try {
    await runPush({
      ref: undefined,
      layout: tmp,
      plainHttp: true,
      username: undefined,
      password: undefined,
    })
    // Manifest URL should use ref from index.json: localhost:5000/test:1.0
    const manifestCall = fetchMock.mock.calls[3]
    expect(manifestCall?.[0]).toContain("/v2/test/manifests/1.0")
  } finally {
    vi.unstubAllGlobals()
    await rm(tmp, { recursive: true })
  }
})

test("runPush throws when layout directory missing", async () => {
  await expect(
    runPush({
      ref: "localhost:5000/test:1.0",
      layout: "/nonexistent/path",
      plainHttp: true,
      username: undefined,
      password: undefined,
    }),
  ).rejects.toThrow()
})

import { mkdtempSync, writeFileSync } from "node:fs"
import { encodeAuth } from "../config"
import { runPushFromArgs } from "../push"

test("runPushFromArgs falls back to config credentials", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "push-test-"))
  await setupTestLayout(tmp)

  const configDir = mkdtempSync(join(tmpdir(), "creatifact-cfg-"))
  const configPath = join(configDir, "config.json")
  writeFileSync(
    configPath,
    JSON.stringify({
      auths: { "localhost:5000": { auth: encodeAuth("cfguser", "cfgpw"), insecure: true } },
    }),
  )

  const fetchMock = vi.fn()
  fetchMock
    .mockResolvedValueOnce({
      // probe → Basic challenge
      ok: false,
      status: 401,
      headers: { get: () => 'Basic realm="x"' },
    })
    .mockResolvedValueOnce({ ok: false, status: 404 }) // HEAD config → not exists
    .mockResolvedValueOnce({
      ok: true,
      status: 202,
      headers: { get: () => "http://localhost:5000/v2/test/blobs/uploads/uuid-1" },
    })
    .mockResolvedValueOnce({ ok: true, status: 201 }) // PUT config upload
    .mockResolvedValueOnce({ ok: false, status: 404 }) // HEAD layer → not exists
    .mockResolvedValueOnce({
      ok: true,
      status: 202,
      headers: { get: () => "http://localhost:5000/v2/test/blobs/uploads/uuid-2" },
    })
    .mockResolvedValueOnce({ ok: true, status: 201 }) // PUT layer upload
    .mockResolvedValueOnce({ ok: true, status: 201 }) // PUT manifest

  vi.stubGlobal("fetch", fetchMock)

  try {
    await runPushFromArgs(["localhost:5000/test:1.0", "--layout", tmp], { configPath })

    // insecure from config → http scheme without --plain-http
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:5000/v2/")

    const manifestCall = fetchMock.mock.calls[7]
    expect(manifestCall?.[0]).toBe("http://localhost:5000/v2/test/manifests/1.0")
    expect((manifestCall?.[1] as RequestInit | undefined)?.headers).toEqual(
      expect.objectContaining({
        Authorization: `Basic ${encodeAuth("cfguser", "cfgpw")}`,
      }),
    )
  } finally {
    vi.unstubAllGlobals()
    await rm(tmp, { recursive: true })
  }
})
