import { createHash } from "node:crypto"
import {
  type LoadedImage,
  MANIFEST_MEDIA_TYPE,
  type OCIManifest,
  parseRef,
  saveLayout,
} from "./oci"

export { saveLayout }

import { Command } from "commander"
import {
  loadConfig,
  type OpenmmCliConfig,
  resolvePlainHttp,
  resolveRegistryCredentials,
} from "./config"
import { getAuthHeaders, toCredentials } from "./push"
import { addGlobalOptions, ensureOutputDirEmpty, parseArgsWith, resolvePassword } from "./util"

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

export interface PullCommandOptions {
  output?: string
  username?: string
  password?: string
  plainHttp?: boolean
  passwordStdin?: boolean
  configDir?: string
}

export function buildPullCommand(): Command {
  const cmd = new Command("pull")
    .description("Pull an OCI image layout from a registry")
    .argument("[ref]", "Source reference (e.g. localhost:5000/myrepo:1.0)")
    .option("-o, --output <dir>", "Output OCI layout directory (default: ./oci-layout)")
    .option(
      "--username <user>",
      "Registry username (falls back to config, see: openmmcli auth login)",
    )
    .option("--password <pw>", "Registry password (prefer --password-stdin)")
    .option("--password-stdin", "Read password from stdin")
    .option("--plain-http", "Use HTTP instead of HTTPS (or set insecure via config)")
  return addGlobalOptions(cmd)
}

export function pullArgsFromOptions(
  ref: string | undefined,
  o: PullCommandOptions,
): ParsedPullArgs {
  return {
    ref,
    output: o.output,
    username: o.username,
    password: o.password,
    plainHttp: o.plainHttp === true,
    passwordStdin: o.passwordStdin === true,
  }
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
  const { options, positionals } = parseArgsWith<PullCommandOptions>(buildPullCommand(), args)
  return pullArgsFromOptions(positionals[0], options)
}

export interface PullResult {
  outputDir: string
  digest: string
}

export async function runPull(options: PullOptions): Promise<PullResult> {
  const outputDir = options.output || "./oci-layout"

  await ensureOutputDirEmpty(outputDir)

  const image = await fetchImage(options.ref, {
    plainHttp: options.plainHttp,
    username: options.username,
    password: options.password,
    ...(options.config === undefined ? {} : { config: options.config }),
  })

  await saveLayout(outputDir, {
    manifest: image.manifest,
    manifestData: image.manifestBuffer.toString("utf8"),
    manifestDigest: image.manifestDescriptor.digest,
    blobs: image.blobs,
    ref: options.ref,
  })
  console.log(`Pulled ${options.ref} → ${outputDir}`)
  return { outputDir, digest: image.manifestDescriptor.digest }
}

export async function runPullFromArgs(
  args: string[],
  opts?: { configPath?: string },
): Promise<PullResult> {
  return runPullFromParsed(parsePullArgs(args), opts)
}

export async function runPullFromParsed(
  parsed: ParsedPullArgs,
  opts?: { configPath?: string },
): Promise<PullResult> {
  if (!parsed.ref) {
    throw new Error("pull requires a <registry>/<repo>:<tag> argument")
  }

  return runPull({
    ref: parsed.ref,
    output: parsed.output ?? "./oci-layout",
    plainHttp: parsed.plainHttp,
    username: parsed.username,
    password: await resolvePassword(parsed.password, parsed.passwordStdin),
    config: loadConfig(opts?.configPath),
  })
}
