import {
  loadConfig,
  type OpenmmCliConfig,
  resolvePlainHttp,
  resolveRegistryCredentials,
} from "./config"
import { parseRef, readOciLayout } from "./oci"

export { parseRef, readOciLayout }

import { parseCliArgs, resolvePassword } from "./util"

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
    body: new Uint8Array(data),
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
    body: new Uint8Array(data),
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

export function overrideScope(wwwAuthenticate: string, scope: string): string {
  const parsed = parseAuthHeader(wwwAuthenticate)
  if (parsed.scheme !== "Bearer") return wwwAuthenticate

  const parts = [`${parsed.scheme} realm="${parsed.params["realm"] ?? ""}"`]
  if (parsed.params["service"]) {
    parts.push(`service="${parsed.params["service"]}"`)
  }
  parts.push(`scope="${scope}"`)
  return parts.join(",")
}

export interface Credentials {
  username: string
  password: string
}

export function toCredentials(
  username: string | undefined,
  password: string | undefined,
): Credentials | undefined {
  return username && password ? { username, password } : undefined
}

function encodeBasicAuth(creds: Credentials): string {
  const encoded = Buffer.from(`${creds.username}:${creds.password}`).toString("base64")
  return `Basic ${encoded}`
}

async function fetchBearerToken(
  parsed: ParsedAuthHeader,
  credentials: Credentials | undefined,
): Promise<string> {
  const realm = parsed.params["realm"]
  if (!realm) {
    throw new Error("Bearer auth missing realm in WWW-Authenticate header")
  }

  const params = new URLSearchParams()
  if (parsed.params["service"]) {
    params.set("service", parsed.params["service"])
  }
  if (parsed.params["scope"]) {
    params.set("scope", parsed.params["scope"])
  }

  const tokenUrl = `${realm}?${params.toString()}`
  const headers: Record<string, string> = {}
  if (credentials) {
    headers["Authorization"] = encodeBasicAuth(credentials)
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
  return token
}

export async function resolveAuth(
  wwwAuthenticate: string,
  credentials: Credentials | undefined,
): Promise<Record<string, string>> {
  const parsed = parseAuthHeader(wwwAuthenticate)

  if (parsed.scheme === "Basic" && credentials) {
    return { Authorization: encodeBasicAuth(credentials) }
  }

  if (parsed.scheme === "Bearer") {
    const token = await fetchBearerToken(parsed, credentials)
    return { Authorization: `Bearer ${token}` }
  }

  return {}
}

export async function getAuthHeaders(
  baseUrl: string,
  scope: string,
  credentials: Credentials | undefined,
): Promise<Record<string, string>> {
  let authHeaders: Record<string, string> = {}
  const probeResp = await fetch(`${baseUrl}/v2/`, { method: "GET", headers: authHeaders })
  if (probeResp.status === 401) {
    const wwwAuth = probeResp.headers.get("www-authenticate")
    if (wwwAuth) {
      authHeaders = await resolveAuth(overrideScope(wwwAuth, scope), credentials)
    }
  }
  return authHeaders
}

export interface PushOptions {
  ref: string | undefined
  layout: string
  plainHttp: boolean
  username: string | undefined
  password: string | undefined
  config?: OpenmmCliConfig
}

const VALUE_OPTS: Record<string, string> = {
  "--layout": "layout",
  "--username": "username",
  "--password": "password",
}

const BOOL_FLAGS: Record<string, string> = {
  "--password-stdin": "passwordStdin",
  "--plain-http": "plainHttp",
}

export interface ParsedPushArgs {
  ref: string | undefined
  layout: string | undefined
  username: string | undefined
  password: string | undefined
  passwordStdin: boolean
  plainHttp: boolean
}

export function parsePushArgs(args: string[]): ParsedPushArgs {
  const parsed = parseCliArgs(args, { values: VALUE_OPTS, flags: BOOL_FLAGS })
  return {
    ref: parsed.positionals[0],
    layout: singleValue(parsed.values["layout"]),
    username: singleValue(parsed.values["username"]),
    password: singleValue(parsed.values["password"]),
    passwordStdin: parsed.flags["passwordStdin"] === true,
    plainHttp: parsed.flags["plainHttp"] === true,
  }
}

function singleValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined
}

export const PUSH_USAGE = `Usage: openmmcli package push <registry>/<repo>:<tag> [options]

Push an OCI image layout to a registry.

Arguments:
  <registry>/<repo>:<tag>  Destination reference (e.g. localhost:5000/myrepo:1.0)
                           If omitted, uses ref from index.json

Options:
  --layout <dir>        OCI layout directory (default: ./oci-layout)
  --username <user>     Registry username (falls back to config, see: openmmcli auth login)
  --password <pw>       Registry password (prefer --password-stdin)
  --password-stdin      Read password from stdin
  --plain-http          Use HTTP instead of HTTPS (or set insecure via config)
  -h, --help            Show this help message`

export async function runPush(options: PushOptions): Promise<void> {
  const layoutDir = options.layout || "./oci-layout"

  const layout = await readOciLayout(layoutDir)

  const effectiveRef = options.ref ?? layout.refName
  if (!effectiveRef) {
    throw new Error("No ref specified and no ref found in index.json")
  }

  const parsed = parseRef(effectiveRef)
  const config = options.config ?? {}
  const credentials = resolveRegistryCredentials(
    parsed.registry,
    options.username,
    options.password,
    config,
  )
  const scheme = resolvePlainHttp(parsed.registry, options.plainHttp, config) ? "http" : "https"
  const baseUrl = `${scheme}://${parsed.registry}`

  const authHeaders = await getAuthHeaders(
    baseUrl,
    `repository:${parsed.repository}:push,pull`,
    credentials ? toCredentials(credentials.username, credentials.password) : undefined,
  )

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

export async function runPushFromArgs(
  args: string[],
  opts?: { configPath?: string },
): Promise<void> {
  const parsed = parsePushArgs(args)

  await runPush({
    ref: parsed.ref,
    layout: parsed.layout ?? "./oci-layout",
    plainHttp: parsed.plainHttp,
    username: parsed.username,
    password: await resolvePassword(parsed.password, parsed.passwordStdin),
    config: loadConfig(opts?.configPath),
  })
}
