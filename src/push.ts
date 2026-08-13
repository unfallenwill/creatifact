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

export interface PushOptions {
  ref: string | undefined
  layout: string
  plainHttp: boolean
  username: string | undefined
  password: string | undefined
  passwordStdin: boolean
}

export function parsePushArgs(args: string[]): {
  ref: string | undefined
  layout: string | undefined
  username: string | undefined
  password: string | undefined
  passwordStdin: boolean
  plainHttp: boolean
} {
  let ref: string | undefined
  let layout: string | undefined
  let username: string | undefined
  let password: string | undefined
  let passwordStdin = false
  let plainHttp = false

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === undefined) {
      i++
      continue
    }
    if (arg === "--layout") {
      layout = args[++i]
      i++
    } else if (arg === "--username") {
      username = args[++i]
      i++
    } else if (arg === "--password") {
      password = args[++i]
      i++
    } else if (arg === "--password-stdin") {
      passwordStdin = true
      i++
    } else if (arg === "--plain-http") {
      plainHttp = true
      i++
    } else if (!arg.startsWith("-")) {
      ref = arg
      i++
    } else {
      i++
    }
  }

  return { ref, layout, username, password, passwordStdin, plainHttp }
}

export const PUSH_USAGE = `Usage: openmmcli push <registry>/<repo>:<tag> [options]

Push an OCI image layout to a registry.

Arguments:
  <registry>/<repo>:<tag>  Destination reference (e.g. localhost:5000/myrepo:1.0)
                           If omitted, uses ref from index.json

Options:
  --layout <dir>        OCI layout directory (default: ./oci-layout)
  --username <user>     Registry username
  --password <pw>       Registry password (prefer --password-stdin)
  --password-stdin      Read password from stdin
  --plain-http          Use HTTP instead of HTTPS (for local registries)
  -h, --help            Show this help message`

export async function runPush(options: PushOptions): Promise<void> {
  const layoutDir = options.layout || "./oci-layout"

  const layout = await readOciLayout(layoutDir)

  const effectiveRef = options.ref ?? layout.refName
  if (!effectiveRef) {
    throw new Error("No ref specified and no ref found in index.json")
  }

  const parsed = parseRef(effectiveRef)
  const scheme = options.plainHttp ? "http" : "https"
  const baseUrl = `${scheme}://${parsed.registry}`

  let authHeaders: Record<string, string> = {}
  const credentials =
    options.username && options.password
      ? { username: options.username, password: options.password }
      : undefined

  // Probe for auth requirement
  const probeResp = await fetch(`${baseUrl}/v2/`, {
    method: "GET",
    headers: authHeaders,
  })
  if (probeResp.status === 401) {
    const wwwAuth = probeResp.headers.get("www-authenticate")
    if (wwwAuth) {
      authHeaders = await resolveAuth(wwwAuth, credentials)
    }
  }

  // Upload blobs (config + layers)
  const allDescriptors = [layout.manifest.config, ...layout.manifest.layers]
  for (const desc of allDescriptors) {
    const exists = await checkBlobExists(baseUrl, parsed.repository, desc.digest, authHeaders)
    if (!exists) {
      const blobData = layout.blobs.get(desc.digest)
      if (!blobData) {
        throw new Error(`Blob ${desc.digest} not found in layout`)
      }
      await uploadBlob(baseUrl, parsed.repository, desc.digest, blobData, authHeaders)
      console.log(`Uploaded ${desc.digest} (${desc.size} bytes)`)
    }
  }

  // Push manifest
  await pushManifest(
    baseUrl,
    parsed.repository,
    parsed.tag,
    layout.manifestBuffer,
    layout.manifestDescriptor.mediaType,
    authHeaders,
  )
  console.log(`Pushed ${effectiveRef}`)
}

export async function runPushFromArgs(args: string[]): Promise<void> {
  const parsed = parsePushArgs(args)

  let password = parsed.password
  if (parsed.passwordStdin) {
    const chunks: Buffer[] = []
    await new Promise<void>((resolve) => {
      process.stdin.on("data", (chunk) => chunks.push(chunk))
      process.stdin.on("end", () => resolve())
      process.stdin.on("error", () => resolve())
    })
    password = Buffer.concat(chunks).toString("utf8").trim() || undefined
  }

  await runPush({
    ref: parsed.ref,
    layout: parsed.layout ?? "./oci-layout",
    plainHttp: parsed.plainHttp,
    username: parsed.username,
    password,
    passwordStdin: parsed.passwordStdin,
  })
}
