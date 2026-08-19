import { existsSync } from "node:fs"

import {
  type Credentials,
  encodeBasicAuth,
  envForConfigPath,
  loadConfig,
  resolvePlainHttp,
  resolveRegistryCredentials,
  storeDir,
  toCredentials,
} from "./config"
import { parseRef, readOciLayout } from "./oci"

export { type Credentials, encodeBasicAuth, toCredentials } from "./config"
export { parseRef, readOciLayout }

import { Command } from "commander"
import { addGlobalOptions, parseArgsWith, resolvePassword } from "./util"

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
  layout: string | undefined
  plainHttp: boolean
  username: string | undefined
  password: string | undefined
  configPath?: string | undefined
}

export interface PushCommandOptions {
  layout?: string
  username?: string
  password?: string
  passwordStdin?: boolean
  plainHttp?: boolean
  configDir?: string
}

export function buildPushCommand(): Command {
  const cmd = new Command("push")
    .description("Push an OCI image layout to a registry")
    .argument("[ref]", "Destination reference; if omitted, uses ref from index.json")
    .option("--layout <dir>", "OCI layout directory (default: tag in ~/.creatifact/store)")
    .option(
      "--username <user>",
      "Registry username (falls back to config, see: creatifact auth login)",
    )
    .option("--password <pw>", "Registry password (prefer --password-stdin)")
    .option("--password-stdin", "Read password from stdin")
    .option("--plain-http", "Use HTTP instead of HTTPS (or set insecure via config)")
  return addGlobalOptions(cmd)
}

export function pushArgsFromOptions(
  ref: string | undefined,
  o: PushCommandOptions,
): ParsedPushArgs {
  return {
    ref,
    layout: o.layout,
    username: o.username,
    password: o.password,
    passwordStdin: o.passwordStdin === true,
    plainHttp: o.plainHttp === true,
  }
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
  const { options, positionals } = parseArgsWith<PushCommandOptions>(buildPushCommand(), args)
  return pushArgsFromOptions(positionals[0], options)
}

export interface PushResult {
  digest: string
  tag: string
}

export async function runPush(options: PushOptions): Promise<PushResult> {
  // --layout pins an explicit layout dir; otherwise the tag is looked up in
  // the shared store (~/.creatifact/store).
  const layoutDir =
    options.layout ??
    (options.ref !== undefined ? storeDir(envForConfigPath(options.configPath)) : undefined)
  if (layoutDir === undefined) {
    throw new Error("push requires a <ref> (to locate it in ~/.creatifact/store) or --layout <dir>")
  }
  if (!existsSync(layoutDir)) {
    throw new Error(
      `no image layout at '${layoutDir}'; build or pull it first, or pass --layout <dir>`,
    )
  }

  const layout = await readOciLayout(
    layoutDir,
    options.layout === undefined ? options.ref : undefined,
  )

  const effectiveRef = options.ref ?? layout.refName
  if (!effectiveRef) {
    throw new Error("No ref specified and no ref found in index.json")
  }

  const parsed = parseRef(effectiveRef)
  const config = loadConfig(options.configPath)
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
  return { digest: layout.manifestDescriptor.digest, tag: effectiveRef }
}

export async function runPushFromArgs(
  args: string[],
  opts?: { configPath?: string },
): Promise<PushResult> {
  return runPushFromParsed(parsePushArgs(args), opts)
}

export async function runPushFromParsed(
  parsed: ParsedPushArgs,
  opts?: { configPath?: string },
): Promise<PushResult> {
  return runPush({
    ref: parsed.ref,
    layout: parsed.layout,
    plainHttp: parsed.plainHttp,
    username: parsed.username,
    password: await resolvePassword(parsed.password, parsed.passwordStdin),
    configPath: opts?.configPath,
  })
}
