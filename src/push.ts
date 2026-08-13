import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { OCIDescriptor, OCIManifest } from "./pack"

export interface ParsedRef {
  registry: string
  repository: string
  tag: string
}

export interface OciLayoutData {
  manifestDescriptor: OCIDescriptor
  manifest: OCIManifest
  manifestBuffer: Buffer
  refName: string | undefined
  blobs: Map<string, Buffer>
}

export function parseRef(ref: string): ParsedRef {
  let registry = "docker.io"
  let rest = ref

  const slashIdx = ref.indexOf("/")
  if (slashIdx > 0) {
    const firstPart = ref.slice(0, slashIdx)
    if (firstPart.includes(".") || firstPart.includes(":") || firstPart === "localhost") {
      registry = firstPart
      rest = ref.slice(slashIdx + 1)
    }
  }

  const colonIdx = rest.lastIndexOf(":")
  let tag = "latest"
  let repository = rest
  if (colonIdx > 0) {
    tag = rest.slice(colonIdx + 1)
    repository = rest.slice(0, colonIdx)
  }

  return { registry, repository, tag }
}

export async function readOciLayout(layoutDir: string): Promise<OciLayoutData> {
  const indexRaw = await readFile(join(layoutDir, "index.json"), "utf8")
  const index = JSON.parse(indexRaw) as {
    manifests: Array<OCIDescriptor & { annotations?: Record<string, string> }>
  }
  const manifestEntry = index.manifests[0]
  if (!manifestEntry) {
    throw new Error("No manifest found in index.json")
  }

  const manifestDigest = manifestEntry.digest
  const hex = manifestDigest.slice("sha256:".length)
  const manifestBuffer = await readFile(join(layoutDir, "blobs", "sha256", hex))
  const manifest = JSON.parse(manifestBuffer.toString("utf8")) as OCIManifest

  const blobs = new Map<string, Buffer>()
  const allDescriptors = [manifest.config, ...manifest.layers]
  for (const desc of allDescriptors) {
    const blobHex = desc.digest.slice("sha256:".length)
    const blobData = await readFile(join(layoutDir, "blobs", "sha256", blobHex))
    blobs.set(desc.digest, blobData)
  }

  return {
    manifestDescriptor: {
      mediaType: manifestEntry.mediaType,
      digest: manifestEntry.digest,
      size: manifestEntry.size,
    },
    manifest,
    manifestBuffer,
    refName: manifestEntry.annotations?.["org.opencontainers.image.ref.name"],
    blobs,
  }
}

export async function checkBlobExists(
  baseUrl: string,
  repository: string,
  digest: string,
  headers: Record<string, string>,
): Promise<boolean> {
  const resp = await fetch(`${baseUrl}/v2/${repository}/blobs/${digest}`, {
    method: "HEAD",
    headers,
  })
  return resp.ok
}

export async function uploadBlob(
  baseUrl: string,
  repository: string,
  digest: string,
  data: Buffer,
  headers: Record<string, string>,
): Promise<void> {
  const postResp = await fetch(`${baseUrl}/v2/${repository}/blobs/uploads/`, {
    method: "POST",
    headers,
  })
  if (!postResp.ok) {
    throw new Error(`Failed to initiate upload for ${digest}: ${postResp.status}`)
  }

  const location = postResp.headers.get("location")
  if (!location) {
    throw new Error("Registry did not return upload Location")
  }

  const uploadUrl = location.startsWith("http")
    ? `${location}?digest=${digest}`
    : `${baseUrl}${location}?digest=${digest}`

  const putResp = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      ...headers,
      "Content-Type": "application/octet-stream",
      "Content-Length": data.length.toString(),
    },
    body: data,
  })
  if (!putResp.ok) {
    const body = await putResp.text().catch(() => "")
    throw new Error(`Failed to upload blob ${digest}: ${putResp.status} ${body}`)
  }
}

export async function pushManifest(
  baseUrl: string,
  repository: string,
  tag: string,
  data: Buffer,
  mediaType: string,
  headers: Record<string, string>,
): Promise<void> {
  const resp = await fetch(`${baseUrl}/v2/${repository}/manifests/${tag}`, {
    method: "PUT",
    headers: {
      ...headers,
      "Content-Type": mediaType,
    },
    body: data,
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => "")
    throw new Error(`Failed to push manifest: ${resp.status} ${body}`)
  }
}

export interface ParsedAuthHeader {
  scheme: string
  params: Record<string, string>
}

export function parseAuthHeader(header: string): ParsedAuthHeader {
  const spaceIdx = header.indexOf(" ")
  const scheme = spaceIdx > 0 ? header.slice(0, spaceIdx) : header
  const rest = spaceIdx > 0 ? header.slice(spaceIdx + 1) : ""

  const params: Record<string, string> = {}
  const regex = /(\w+)="([^"]*)"/g
  let match = regex.exec(rest)
  while (match !== null) {
    const key = match[1]
    const value = match[2]
    if (key !== undefined && value !== undefined) {
      params[key] = value
    }
    match = regex.exec(rest)
  }

  return { scheme, params }
}

export interface Credentials {
  username: string
  password: string
}

export async function resolveAuth(
  wwwAuthenticate: string,
  credentials: Credentials | undefined,
): Promise<Record<string, string>> {
  const parsed = parseAuthHeader(wwwAuthenticate)

  if (parsed.scheme === "Basic") {
    if (credentials) {
      const encoded = Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")
      return { Authorization: `Basic ${encoded}` }
    }
    return {}
  }

  if (parsed.scheme === "Bearer") {
    const realm = parsed.params.realm
    if (!realm) {
      throw new Error("Bearer auth missing realm in WWW-Authenticate header")
    }

    const params = new URLSearchParams()
    if (parsed.params.service) {
      params.set("service", parsed.params.service)
    }
    if (parsed.params.scope) {
      params.set("scope", parsed.params.scope)
    }

    const tokenUrl = `${realm}?${params.toString()}`
    const headers: Record<string, string> = {}
    if (credentials) {
      const encoded = Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")
      headers.Authorization = `Basic ${encoded}`
    }

    const resp = await fetch(tokenUrl, { method: "GET", headers })
    if (!resp.ok) {
      throw new Error(`Failed to fetch token: ${resp.status}`)
    }

    const body = (await resp.json()) as { token?: string; access_token?: string }
    const token = body.token ?? body.access_token
    if (!token) {
      throw new Error("Token endpoint did not return a token")
    }

    return { Authorization: `Bearer ${token}` }
  }

  return {}
}
