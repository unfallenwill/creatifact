import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import {
  INDEX_MEDIA_TYPE,
  type LoadedImage,
  MANIFEST_MEDIA_TYPE,
  materializeBlob,
  type OCIManifest,
  parseRef,
  registryApiHost,
  saveLayout,
  upsertStoreEntry,
} from "./oci"

export { saveLayout }

import { Command } from "commander"
import {
  type CreatifactConfig,
  defaultRegistry,
  envForConfigPath,
  loadConfig,
  resolvePlainHttp,
  resolveRegistryCredentials,
  storeDir,
} from "./config"
import { ok, status } from "./format"
import { getAuthHeaders, toCredentials } from "./push"
import { addGlobalOptions, ensureOutputDirEmpty, parseArgsWith, resolvePassword } from "./util"

export interface ImageFetchOptions {
  plainHttp: boolean
  username: string | undefined
  password: string | undefined
  /** Loaded config for credential/insecure fallback; omit to disable. */
  config?: CreatifactConfig
}

export async function fetchImage(ref: string, opts: ImageFetchOptions): Promise<LoadedImage> {
  const config = opts.config ?? {}
  const parsed = parseRef(ref, defaultRegistry(config))
  const credentials = resolveRegistryCredentials(
    parsed.registry,
    opts.username,
    opts.password,
    config,
  )
  const scheme = resolvePlainHttp(parsed.registry, opts.plainHttp, config) ? "http" : "https"
  const baseUrl = `${scheme}://${registryApiHost(parsed.registry)}`

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
    status(`downloaded ${desc.digest} (${desc.size} bytes)`)
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

/** Every manifest type a registry may serve for a ref: OCI and docker,
 * single-image and index. Registries 404 unknown types out of Accept lists. */
const MANIFEST_ACCEPT = [
  MANIFEST_MEDIA_TYPE,
  INDEX_MEDIA_TYPE,
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
].join(", ")

interface IndexEntry {
  mediaType?: string
  digest: string
  platform?: { architecture?: string; os?: string }
}

/** Prefer linux/amd64, then any linux, then the first entry. */
function selectIndexEntry(entries: IndexEntry[]): IndexEntry | undefined {
  const candidates = entries.filter((e) => typeof e.digest === "string")
  return (
    candidates.find((e) => e.platform?.os === "linux" && e.platform?.architecture === "amd64") ??
    candidates.find((e) => e.platform?.os === "linux") ??
    candidates[0]
  )
}

export async function fetchManifest(
  baseUrl: string,
  repository: string,
  tag: string,
  headers: Record<string, string>,
): Promise<{ manifest: OCIManifest; mediaType: string; manifestData: string }> {
  // A ref may resolve to a multi-arch index; follow it (bounded) down to a
  // single-image manifest so callers always see concrete config + layers.
  let ref = tag
  for (let depth = 0; ; depth++) {
    const resp = await fetch(`${baseUrl}/v2/${repository}/manifests/${ref}`, {
      method: "GET",
      headers: {
        ...headers,
        Accept: MANIFEST_ACCEPT,
      },
    })
    if (!resp.ok) {
      const body = await resp.text().catch(() => "")
      throw new Error(`Failed to fetch manifest: ${resp.status} ${body}`)
    }

    const mediaType = resp.headers.get("content-type") ?? MANIFEST_MEDIA_TYPE
    const manifestData = await resp.text()
    const manifest = JSON.parse(manifestData) as OCIManifest & { manifests?: unknown }
    if (!Array.isArray(manifest.manifests)) {
      return { manifest, mediaType, manifestData }
    }
    if (depth >= 3) {
      throw new Error("manifest index nesting too deep")
    }
    const chosen = selectIndexEntry(manifest.manifests as IndexEntry[])
    if (chosen === undefined) {
      throw new Error("manifest index has no entries")
    }
    ref = chosen.digest
  }
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
  output: string | undefined
  plainHttp: boolean
  username: string | undefined
  password: string | undefined
  configPath?: string | undefined
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
    .option(
      "-o, --output <dir>",
      "Export a standalone OCI layout directory (default: ~/.creatifact/store)",
    )
    .option(
      "--username <user>",
      "Registry username (falls back to config, see: creatifact auth login)",
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
  // Default target is the shared store (tag = pointer, blobs deduped);
  // an explicit --output exports a standalone layout (must be empty).
  const explicit = options.output !== undefined
  const outputDir =
    options.output !== undefined ? options.output : storeDir(envForConfigPath(options.configPath))
  if (explicit) {
    await ensureOutputDirEmpty(outputDir)
  }

  const image = await fetchImage(options.ref, {
    plainHttp: options.plainHttp,
    username: options.username,
    password: options.password,
    config: loadConfig(options.configPath),
  })

  if (explicit) {
    await saveLayout(outputDir, {
      manifest: image.manifest,
      manifestData: image.manifestBuffer.toString("utf8"),
      manifestDigest: image.manifestDescriptor.digest,
      blobs: image.blobs,
      ref: options.ref,
    })
  } else {
    const blobsDir = join(outputDir, "blobs", "sha256")
    await mkdir(blobsDir, { recursive: true })
    for (const [digest, data] of image.blobs) {
      await materializeBlob(blobsDir, digest, data)
    }
    await materializeBlob(blobsDir, image.manifestDescriptor.digest, image.manifestBuffer)
    await upsertStoreEntry(outputDir, image.manifestDescriptor, options.ref)
  }
  console.log(`Pulled ${options.ref} → ${outputDir}${explicit ? "" : " (store)"}`)
  ok(`pulled ${options.ref}`)
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
    output: parsed.output,
    plainHttp: parsed.plainHttp,
    username: parsed.username,
    password: await resolvePassword(parsed.password, parsed.passwordStdin),
    configPath: opts?.configPath,
  })
}
