import { createHash } from "node:crypto"
import { vi } from "vitest"
import { registryApiHost } from "../oci"
import { fetchBlob, fetchManifest } from "../pull"

test("registryApiHost rewrites docker.io aliases to the API host", () => {
  expect(registryApiHost("docker.io")).toBe("registry-1.docker.io")
  expect(registryApiHost("index.docker.io")).toBe("registry-1.docker.io")
  expect(registryApiHost("creatifact.dev")).toBe("creatifact.dev")
  expect(registryApiHost("localhost:5000")).toBe("localhost:5000")
})

test("fetchManifest GETs manifest from registry", async () => {
  const manifestData = JSON.stringify({ schemaVersion: 2, config: {}, layers: [] })
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => "application/vnd.oci.image.manifest.v1+json" },
    text: () => Promise.resolve(manifestData),
  })
  vi.stubGlobal("fetch", fetchMock)

  const {
    manifest,
    mediaType,
    manifestData: rawData,
  } = await fetchManifest("http://localhost:5000", "myrepo", "1.0", {})

  expect(mediaType).toBe("application/vnd.oci.image.manifest.v1+json")
  expect(manifest.schemaVersion).toBe(2)
  expect(rawData).toBe(manifestData)
  expect(fetchMock).toHaveBeenCalledWith(
    "http://localhost:5000/v2/myrepo/manifests/1.0",
    expect.objectContaining({
      method: "GET",
      headers: expect.objectContaining({
        Accept: expect.stringContaining("application/vnd.oci.image.manifest.v1+json"),
      }),
    }),
  )
  // the Accept list must cover every manifest type registries may serve
  const sentAccept = (fetchMock.mock.calls[0]?.[1] as { headers?: { Accept?: string } })?.headers
    ?.Accept
  expect(sentAccept).toContain("application/vnd.oci.image.index.v1+json")
  expect(sentAccept).toContain("application/vnd.docker.distribution.manifest.v2+json")
  expect(sentAccept).toContain("application/vnd.docker.distribution.manifest.list.v2+json")

  vi.unstubAllGlobals()
})

test("fetchManifest resolves a multi-arch index to the linux/amd64 child", async () => {
  const armManifest = JSON.stringify({ schemaVersion: 2, config: {}, layers: [] })
  const armDigest = `sha256:${createHash("sha256").update(armManifest).digest("hex")}`
  const amdManifest = JSON.stringify({ schemaVersion: 2, config: {}, layers: [] })
  const amdDigest = `sha256:${createHash("sha256").update(amdManifest).digest("hex")}`
  const indexData = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: armDigest,
        size: armManifest.length,
        platform: { architecture: "arm64", os: "linux" },
      },
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: amdDigest,
        size: amdManifest.length,
        platform: { architecture: "amd64", os: "linux" },
      },
    ],
  })
  const fetchMock = vi.fn((url: string) =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: {
        get: () =>
          url.includes("sha256:")
            ? "application/vnd.oci.image.manifest.v1+json"
            : "application/vnd.oci.image.index.v1+json",
      },
      text: () => Promise.resolve(url.includes("sha256:") ? amdManifest : indexData),
    }),
  )
  vi.stubGlobal("fetch", fetchMock)

  const { manifestData } = await fetchManifest("http://localhost:5000", "myrepo", "latest", {})

  expect(manifestData).toBe(amdManifest)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(fetchMock).toHaveBeenLastCalledWith(
    `http://localhost:5000/v2/myrepo/manifests/${amdDigest}`,
    expect.objectContaining({ method: "GET" }),
  )

  vi.unstubAllGlobals()
})

test("fetchManifest verifies a manifest fetched by digest", async () => {
  const manifestData = JSON.stringify({ schemaVersion: 2, config: {}, layers: [] })
  const digest = `sha256:${createHash("sha256").update(manifestData).digest("hex")}`
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => "application/vnd.oci.image.manifest.v1+json" },
    text: () => Promise.resolve(manifestData),
  })
  vi.stubGlobal("fetch", fetchMock)

  const { manifestData: rawData } = await fetchManifest(
    "http://localhost:5000",
    "myrepo",
    digest,
    {},
  )
  expect(rawData).toBe(manifestData)

  vi.unstubAllGlobals()
})

test("fetchManifest rejects bytes that don't hash to the requested digest", async () => {
  const digest = `sha256:${createHash("sha256").update("expected").digest("hex")}`
  // Valid JSON whose sha256 differs from the requested digest.
  const tampered = JSON.stringify({ schemaVersion: 2, config: {}, layers: [], tampered: true })
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => "application/vnd.oci.image.manifest.v1+json" },
    text: () => Promise.resolve(tampered),
  })
  vi.stubGlobal("fetch", fetchMock)

  await expect(fetchManifest("http://localhost:5000", "myrepo", digest, {})).rejects.toThrow(
    "Manifest digest mismatch",
  )

  vi.unstubAllGlobals()
})

test("fetchManifest rejects an index child that doesn't hash to its declared digest", async () => {
  const armManifest = JSON.stringify({ schemaVersion: 2, config: {}, layers: [] })
  const armDigest = `sha256:${createHash("sha256").update(armManifest).digest("hex")}`
  // Distinct bytes from armManifest so the two child digests differ.
  const amdManifest = JSON.stringify({ schemaVersion: 2, config: {}, layers: [], amd64: true })
  const amdDigest = `sha256:${createHash("sha256").update(amdManifest).digest("hex")}`
  const indexData = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: armDigest,
        size: armManifest.length,
        platform: { architecture: "arm64", os: "linux" },
      },
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: amdDigest,
        size: amdManifest.length,
        platform: { architecture: "amd64", os: "linux" },
      },
    ],
  })
  // The registry lies: it serves arm64 bytes at the amd64 child's digest.
  const fetchMock = vi.fn((url: string) =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: () => Promise.resolve(url.includes("sha256:") ? armManifest : indexData),
    }),
  )
  vi.stubGlobal("fetch", fetchMock)

  await expect(fetchManifest("http://localhost:5000", "myrepo", "latest", {})).rejects.toThrow(
    "Manifest digest mismatch",
  )

  vi.unstubAllGlobals()
})

test("fetchManifest throws on failure", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("not found"),
    }),
  )

  await expect(fetchManifest("http://localhost:5000", "myrepo", "1.0", {})).rejects.toThrow("404")

  vi.unstubAllGlobals()
})

test("fetchBlob downloads blob data", async () => {
  const blobData = Buffer.from("layer content")
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    arrayBuffer: () =>
      Promise.resolve(
        blobData.buffer.slice(blobData.byteOffset, blobData.byteOffset + blobData.byteLength),
      ),
  })
  vi.stubGlobal("fetch", fetchMock)

  const data = await fetchBlob("http://localhost:5000", "myrepo", "sha256:abc123", {})

  expect(data).toEqual(blobData)
  expect(fetchMock).toHaveBeenCalledWith(
    "http://localhost:5000/v2/myrepo/blobs/sha256:abc123",
    expect.objectContaining({ method: "GET" }),
  )

  vi.unstubAllGlobals()
})

test("fetchBlob throws on failure", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }))

  await expect(fetchBlob("http://localhost:5000", "myrepo", "sha256:abc", {})).rejects.toThrow(
    "404",
  )

  vi.unstubAllGlobals()
})

import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fetchImage, saveLayout } from "../pull"

function sha256hex(data: string): string {
  return createHash("sha256").update(data).digest("hex")
}

test("fetchImage downloads manifest and blobs into a LoadedImage", async () => {
  const configData = "{}"
  const configDigest = `sha256:${sha256hex(configData)}`
  const layerData = "layer-bytes"
  const layerDigest = `sha256:${sha256hex(layerData)}`
  const manifestObj = {
    schemaVersion: 2 as const,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.empty.v1+json", digest: configDigest, size: 2 },
    layers: [
      { mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: layerDigest, size: 11 },
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
    const image = await fetchImage("localhost:5000/test:1.0", {
      plainHttp: true,
      username: undefined,
      password: undefined,
    })

    expect(image.manifestDescriptor.digest).toBe(`sha256:${sha256hex(manifestData)}`)
    expect(image.blobs.get(configDigest)?.toString()).toBe(configData)
    expect(image.blobs.get(layerDigest)?.toString()).toBe(layerData)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  } finally {
    vi.unstubAllGlobals()
  }
})

test("fetchImage throws on blob digest mismatch", async () => {
  const configData = "{}"
  const configDigest = `sha256:${sha256hex(configData)}`
  const manifestObj = {
    schemaVersion: 2 as const,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.empty.v1+json", digest: configDigest, size: 2 },
    layers: [],
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
      arrayBuffer: () => Promise.resolve(Buffer.from("tampered")),
    })

  vi.stubGlobal("fetch", fetchMock)

  try {
    await expect(
      fetchImage("localhost:5000/test:1.0", {
        plainHttp: true,
        username: undefined,
        password: undefined,
      }),
    ).rejects.toThrow("digest mismatch")
  } finally {
    vi.unstubAllGlobals()
  }
})

test("saveLayout writes complete OCI layout from manifest + blobs", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "pull-test-"))

  const configData = "{}"
  const configDigest = `sha256:${sha256hex(configData)}`
  const layerData = "layer-bytes"
  const layerDigest = `sha256:${sha256hex(layerData)}`

  const manifest = {
    schemaVersion: 2 as const,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.empty.v1+json", digest: configDigest, size: 2 },
    layers: [
      { mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: layerDigest, size: 11 },
    ],
  }
  const manifestData = JSON.stringify(manifest)
  const manifestDigest = `sha256:${sha256hex(manifestData)}`

  const blobs = new Map<string, Buffer>([
    [configDigest, Buffer.from(configData)],
    [layerDigest, Buffer.from(layerData)],
  ])

  await saveLayout(tmp, {
    manifest,
    manifestData,
    manifestDigest,
    blobs,
    ref: "test:1.0",
  })

  expect(existsSync(join(tmp, "oci-layout"))).toBe(true)
  expect(existsSync(join(tmp, "index.json"))).toBe(true)

  const layout = JSON.parse(await readFile(join(tmp, "oci-layout"), "utf8"))
  expect(layout).toEqual({ imageLayoutVersion: "1.0.0" })

  const index = JSON.parse(await readFile(join(tmp, "index.json"), "utf8"))
  expect(index.manifests[0].digest).toBe(manifestDigest)
  expect(index.manifests[0].annotations["org.opencontainers.image.ref.name"]).toBe("test:1.0")

  const configBlob = await readFile(join(tmp, "blobs", "sha256", configDigest.slice(7)))
  expect(configBlob.toString()).toBe(configData)

  const layerBlob = await readFile(join(tmp, "blobs", "sha256", layerDigest.slice(7)))
  expect(layerBlob.toString()).toBe(layerData)

  const manifestBlob = await readFile(join(tmp, "blobs", "sha256", manifestDigest.slice(7)))
  expect(manifestBlob.toString()).toBe(manifestData)

  await rm(tmp, { recursive: true })
})

import { parsePullArgs, runPull } from "../pull"

test("parsePullArgs parses positional ref and flags", () => {
  const result = parsePullArgs([
    "localhost:5000/myrepo:1.0",
    "--output",
    "./my-layout",
    "--plain-http",
    "--password-stdin",
  ])
  expect(result.ref).toBe("localhost:5000/myrepo:1.0")
  expect(result.output).toBe("./my-layout")
  expect(result.plainHttp).toBe(true)
  expect(result.passwordStdin).toBe(true)
})

test("parsePullArgs applies defaults", () => {
  const result = parsePullArgs(["test:1.0"])
  expect(result.ref).toBe("test:1.0")
  expect(result.output).toBeUndefined()
  expect(result.plainHttp).toBe(false)
  expect(result.passwordStdin).toBe(false)
})

test("runPull fetches manifest and blobs then saves layout", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "pull-test-"))

  const configData = "{}"
  const configDigest = `sha256:${sha256hex(configData)}`
  const layerData = "layer-bytes"
  const layerDigest = `sha256:${sha256hex(layerData)}`
  const manifestObj = {
    schemaVersion: 2 as const,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.empty.v1+json", digest: configDigest, size: 2 },
    layers: [
      { mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: layerDigest, size: 11 },
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
    await runPull({
      ref: "localhost:5000/test:1.0",
      output: tmp,
      plainHttp: true,
      username: undefined,
      password: undefined,
    })

    expect(existsSync(join(tmp, "oci-layout"))).toBe(true)
    expect(existsSync(join(tmp, "index.json"))).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  } finally {
    vi.unstubAllGlobals()
    await rm(tmp, { recursive: true })
  }
})

test("runPull throws when output dir exists and not empty", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "pull-test-"))
  const outputDir = join(tmp, "output")
  await mkdir(outputDir, { recursive: true })
  const { writeFile } = await import("node:fs/promises")
  await writeFile(join(outputDir, "blocking.txt"), "x")

  await expect(
    runPull({
      ref: "localhost:5000/test:1.0",
      output: outputDir,
      plainHttp: true,
      username: undefined,
      password: undefined,
    }),
  ).rejects.toThrow("already exists")

  await rm(tmp, { recursive: true })
})

test("runPull throws when blob digest mismatch", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "pull-test-"))
  const configData = "{}"
  const configDigest = `sha256:${sha256hex(configData)}`
  const manifestObj = {
    schemaVersion: 2 as const,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.empty.v1+json", digest: configDigest, size: 2 },
    layers: [],
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
      arrayBuffer: () => Promise.resolve(Buffer.from("tampered")),
    })

  vi.stubGlobal("fetch", fetchMock)

  try {
    await expect(
      runPull({
        ref: "localhost:5000/test:1.0",
        output: tmp,
        plainHttp: true,
        username: undefined,
        password: undefined,
      }),
    ).rejects.toThrow("digest mismatch")
  } finally {
    vi.unstubAllGlobals()
    await rm(tmp, { recursive: true })
  }
})

import { type CreatifactConfig, encodeAuth } from "../config"

function fetchImageFixtureConfig() {
  const configData = "{}"
  const configDigest = `sha256:${createHash("sha256").update(configData).digest("hex")}`
  const manifestObj = {
    schemaVersion: 2 as const,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.empty.v1+json", digest: configDigest, size: 2 },
    layers: [],
  }
  const manifestData = JSON.stringify(manifestObj)
  return { configData, manifestData }
}

test("fetchImage resolves credentials and insecure from config", async () => {
  const config: CreatifactConfig = {
    auths: { "localhost:5000": { auth: encodeAuth("cfguser", "cfgpw"), insecure: true } },
  }

  const { configData, manifestData } = fetchImageFixtureConfig()

  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({
      // probe → Basic challenge
      ok: false,
      status: 401,
      headers: { get: () => 'Basic realm="x"' },
    })
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

  vi.stubGlobal("fetch", fetchMock)

  try {
    const image = await fetchImage("localhost:5000/test:1.0", {
      plainHttp: false, // config insecure should flip this to http
      username: undefined,
      password: undefined,
      config,
    })

    expect(image.manifest.schemaVersion).toBe(2)

    // probe went to http:// because config marks the registry insecure
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:5000/v2/")

    // manifest request carries Basic credentials from config
    const manifestCall = fetchMock.mock.calls[1]
    expect(manifestCall?.[0]).toBe("http://localhost:5000/v2/test/manifests/1.0")
    expect((manifestCall?.[1] as RequestInit | undefined)?.headers).toEqual(
      expect.objectContaining({
        Authorization: `Basic ${encodeAuth("cfguser", "cfgpw")}`,
      }),
    )
  } finally {
    vi.unstubAllGlobals()
  }
})

test("fetchImage prefers complete CLI credentials over config", async () => {
  const config: CreatifactConfig = {
    auths: { "localhost:5000": { auth: encodeAuth("cfguser", "cfgpw") } },
  }

  const { configData, manifestData } = fetchImageFixtureConfig()

  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({
      ok: false,
      status: 401,
      headers: { get: () => 'Basic realm="x"' },
    })
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

  vi.stubGlobal("fetch", fetchMock)

  try {
    await fetchImage("localhost:5000/test:1.0", {
      plainHttp: true,
      username: "cliuser",
      password: "clipw",
      config,
    })

    const manifestCall = fetchMock.mock.calls[1]
    expect((manifestCall?.[1] as RequestInit | undefined)?.headers).toEqual(
      expect.objectContaining({
        Authorization: `Basic ${encodeAuth("cliuser", "clipw")}`,
      }),
    )
  } finally {
    vi.unstubAllGlobals()
  }
})
