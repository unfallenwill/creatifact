import { createHash } from "node:crypto"
import {
  type LoadedImage,
  MANIFEST_MEDIA_TYPE,
  type OCIManifest,
  parseRef,
  saveLayout,
} from "./oci"

export { saveLayout }

import {
  loadConfig,
  type OpenmmCliConfig,
  resolvePlainHttp,
  resolveRegistryCredentials,
} from "./config"
import { getAuthHeaders, toCredentials } from "./push"
import { ensureOutputDirEmpty, parseCliArgs, resolvePassword } from "./util"

export interface ImageFetchOptions {
  plainHttp: boolean
  username: string | undefined
  password: string | undefined
  /** Loaded config for credential/insecure fallback; omit to disable. */
  config?: OpenmmCliConfig
}

export async function fetchImage(ref: string, opts: ImageFetchOptions): Promise<LoadedImage> {
  const parsed = parseRef(ref)
  const config = opts.config ?? {}
  const credentials = resolveRegistryCredentials(
    parsed.registry,
    opts.username,
    opts.password,
    config,
  )
  const scheme = resolvePlainHttp(parsed.registry, opts.plainHttp, config) ? "http" : "https"
  const baseUrl = `${scheme}://${parsed.registry}`

  const authHeaders = await getAuthHeaders(
    baseUrl,
    `repository:${parsed.repository}:pull`,
    credentials ? toCredentials(credentials.username, credentials.password) : undefined,
  )

  const { manifest, mediaType, manifestData } = await fetchManifest(
    baseUrl,
    parsed.repository,
    parsed.tag,
    authHeaders,
  )

  const blobs = new Map<string, Buffer>()
  const allDescriptors = [manifest.config, ...manifest.layers]
  for (const desc of allDescriptors) {
    const blobData = await fetchBlob(baseUrl, parsed.repository, desc.digest, authHeaders)
    const computed = `sha256:${createHash("sha256").update(blobData).digest("hex")}`
    if (computed !== desc.digest) {
      throw new Error(`Blob digest mismatch: expected ${desc.digest}, got ${computed}`)
    }
    blobs.set(desc.digest, blobData)
    console.log(`Downloaded ${desc.digest} (${desc.size} bytes)`)
  }

  const manifestDigest = `sha256:${createHash("sha256").update(manifestData).digest("hex")}`

  return {
    manifestDescriptor: {
      mediaType,
      digest: manifestDigest,
      size: Buffer.byteLength(manifestData),
    },
    manifest,
    manifestBuffer: Buffer.from(manifestData),
    refName: ref,
    blobs,
  }
}

export async function fetchManifest(
  baseUrl: string,
  repository: string,
  tag: string,
  headers: Record<string, string>,
): Promise<{ manifest: OCIManifest; mediaType: string; manifestData: string }> {
  const resp = await fetch(`${baseUrl}/v2/${repository}/manifests/${tag}`, {
    method: "GET",
    headers: {
      ...headers,
      Accept: MANIFEST_MEDIA_TYPE,
    },
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => "")
    throw new Error(`Failed to fetch manifest: ${resp.status} ${body}`)
  }

  const mediaType = resp.headers.get("content-type") ?? MANIFEST_MEDIA_TYPE
  const manifestData = await resp.text()
  const manifest = JSON.parse(manifestData) as OCIManifest
  return { manifest, mediaType, manifestData }
}

export async function fetchBlob(
  baseUrl: string,
  repository: string,
  digest: string,
  headers: Record<string, string>,
): Promise<Buffer> {
  const resp = await fetch(`${baseUrl}/v2/${repository}/blobs/${digest}`, {
    method: "GET",
    headers,
  })
  if (!resp.ok) {
    throw new Error(`Failed to fetch blob ${digest}: ${resp.status}`)
  }

  const arrayBuffer = await resp.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

export interface PullOptions {
  ref: string
  output: string
  plainHttp: boolean
  username: string | undefined
  password: string | undefined
  config?: OpenmmCliConfig
}

const PULL_STR_OPTS: Record<string, string> = {
  "--output": "output",
  "-o": "output",
  "--username": "username",
  "--password": "password",
}

const PULL_BOOL_FLAGS: Record<string, string> = {
  "--plain-http": "plainHttp",
  "--password-stdin": "passwordStdin",
}

export interface ParsedPullArgs {
  ref: string | undefined
  output: string | undefined
  username: string | undefined
  password: string | undefined
  plainHttp: boolean
  passwordStdin: boolean
}

export function parsePullArgs(args: string[]): ParsedPullArgs {
  const parsed = parseCliArgs(args, { values: PULL_STR_OPTS, flags: PULL_BOOL_FLAGS })
  return {
    ref: parsed.positionals[0],
    output: singleValue(parsed.values["output"]),
    username: singleValue(parsed.values["username"]),
    password: singleValue(parsed.values["password"]),
    plainHttp: parsed.flags["plainHttp"] === true,
    passwordStdin: parsed.flags["passwordStdin"] === true,
  }
}

function singleValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined
}

export const PULL_USAGE = `Usage: openmmcli package pull <registry>/<repo>:<tag> [options]

Pull an OCI image layout from a registry.

Arguments:
  <registry>/<repo>:<tag>  Source reference (e.g. localhost:5000/myrepo:1.0)

Options:
  -o, --output <dir>     Output OCI layout directory (default: ./oci-layout)
  --username <user>      Registry username (falls back to config, see: openmmcli auth login)
  --password <pw>        Registry password (prefer --password-stdin)
  --password-stdin       Read password from stdin
  --plain-http           Use HTTP instead of HTTPS (or set insecure via config)
  -h, --help             Show this help message`

export async function runPull(options: PullOptions): Promise<void> {
  const outputDir = options.output || "./oci-layout"

  await ensureOutputDirEmpty(outputDir)

  const image = await fetchImage(options.ref, {
    plainHttp: options.plainHttp,
    username: options.username,
    password: options.password,
    ...(options.config === undefined ? {} : { config: options.config }),
  })

  await saveLayout(
    outputDir,
    image.manifest,
    image.manifestBuffer.toString("utf8"),
    image.manifestDescriptor.digest,
    image.blobs,
    options.ref,
  )
  console.log(`Pulled ${options.ref} → ${outputDir}`)
}

export async function runPullFromArgs(
  args: string[],
  opts?: { configPath?: string },
): Promise<void> {
  const parsed = parsePullArgs(args)

  if (!parsed.ref) {
    throw new Error("pull requires a <registry>/<repo>:<tag> argument")
  }

  await runPull({
    ref: parsed.ref,
    output: parsed.output ?? "./oci-layout",
    plainHttp: parsed.plainHttp,
    username: parsed.username,
    password: await resolvePassword(parsed.password, parsed.passwordStdin),
    config: loadConfig(opts?.configPath),
  })
}
