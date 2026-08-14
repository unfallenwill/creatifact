import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { OCIManifest } from "./pack"
import { parseRef, resolveAuth } from "./push"

export async function fetchManifest(
  baseUrl: string,
  repository: string,
  tag: string,
  headers: Record<string, string>,
): Promise<{ manifest: OCIManifest; mediaType: string }> {
  const resp = await fetch(`${baseUrl}/v2/${repository}/manifests/${tag}`, {
    method: "GET",
    headers: {
      ...headers,
      Accept: "application/vnd.oci.image.manifest.v1+json",
    },
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => "")
    throw new Error(`Failed to fetch manifest: ${resp.status} ${body}`)
  }

  const mediaType = resp.headers.get("content-type") ?? "application/vnd.oci.image.manifest.v1+json"
  const manifest = (await resp.json()) as OCIManifest
  return { manifest, mediaType }
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

export async function saveLayout(
  outputDir: string,
  manifest: OCIManifest,
  manifestData: string,
  manifestDigest: string,
  blobs: Map<string, Buffer>,
  ref: string,
): Promise<void> {
  const blobsDir = join(outputDir, "blobs", "sha256")
  await mkdir(blobsDir, { recursive: true })

  await writeFile(join(outputDir, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }))

  const index = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      {
        mediaType: manifest.mediaType,
        digest: manifestDigest,
        size: manifestData.length,
        annotations: { "org.opencontainers.image.ref.name": ref },
      },
    ],
  }
  await writeFile(join(outputDir, "index.json"), JSON.stringify(index, null, 2))

  for (const [digest, data] of blobs) {
    const hex = digest.slice("sha256:".length)
    await writeFile(join(blobsDir, hex), data)
  }

  const manifestHex = manifestDigest.slice("sha256:".length)
  await writeFile(join(blobsDir, manifestHex), manifestData)
}

export interface PullOptions {
  ref: string
  output: string
  plainHttp: boolean
  username: string | undefined
  password: string | undefined
}

const PULL_STR_OPTS: Record<string, "output" | "username" | "password"> = {
  "--output": "output",
  "-o": "output",
  "--username": "username",
  "--password": "password",
}

const PULL_BOOL_FLAGS: Record<string, "plainHttp"> = {
  "--plain-http": "plainHttp",
}

export function parsePullArgs(args: string[]): {
  ref: string | undefined
  output: string | undefined
  username: string | undefined
  password: string | undefined
  plainHttp: boolean
} {
  const result = {
    ref: undefined as string | undefined,
    output: undefined as string | undefined,
    username: undefined as string | undefined,
    password: undefined as string | undefined,
    plainHttp: false,
  }

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === undefined) {
      i++
      continue
    }

    const strKey = PULL_STR_OPTS[arg]
    if (strKey !== undefined) {
      const v = args[++i]
      if (v !== undefined) result[strKey] = v
      i++
      continue
    }

    const boolKey = PULL_BOOL_FLAGS[arg]
    if (boolKey !== undefined) {
      result[boolKey] = true
      i++
      continue
    }

    if (!arg.startsWith("-")) {
      result.ref = arg
    }
    i++
  }

  return result
}

export const PULL_USAGE = `Usage: openmmcli pull <registry>/<repo>:<tag> [options]

Pull an OCI image layout from a registry.

Arguments:
  <registry>/<repo>:<tag>  Source reference (e.g. localhost:5000/myrepo:1.0)

Options:
  -o, --output <dir>     Output OCI layout directory (default: ./oci-layout)
  --username <user>      Registry username
  --password <pw>        Registry password
  --plain-http           Use HTTP instead of HTTPS (for local registries)
  -h, --help             Show this help message`

export async function runPull(options: PullOptions): Promise<void> {
  const outputDir = options.output || "./oci-layout"

  if (existsSync(outputDir)) {
    const entries = await readdir(outputDir)
    if (entries.length > 0) {
      throw new Error(`--output '${outputDir}' already exists and is not empty`)
    }
  }

  const parsed = parseRef(options.ref)
  const scheme = options.plainHttp ? "http" : "https"
  const baseUrl = `${scheme}://${parsed.registry}`

  let authHeaders: Record<string, string> = {}
  const credentials =
    options.username && options.password
      ? { username: options.username, password: options.password }
      : undefined

  const probeResp = await fetch(`${baseUrl}/v2/`, { method: "GET", headers: authHeaders })
  if (probeResp.status === 401) {
    const wwwAuth = probeResp.headers.get("www-authenticate")
    if (wwwAuth) {
      authHeaders = await resolveAuth(wwwAuth, credentials)
    }
  }

  const { manifest } = await fetchManifest(baseUrl, parsed.repository, parsed.tag, authHeaders)

  const blobs = new Map<string, Buffer>()
  const allDescriptors = [manifest.config, ...manifest.layers]
  for (const desc of allDescriptors) {
    const blobData = await fetchBlob(baseUrl, parsed.repository, desc.digest, authHeaders)
    blobs.set(desc.digest, blobData)
    console.log(`Downloaded ${desc.digest} (${desc.size} bytes)`)
  }

  const manifestData = JSON.stringify(manifest)
  const manifestHash = createHash("sha256").update(manifestData).digest("hex")
  const manifestDigest = `sha256:${manifestHash}`

  await saveLayout(outputDir, manifest, manifestData, manifestDigest, blobs, options.ref)
  console.log(`Pulled ${options.ref} → ${outputDir}`)
}

export async function runPullFromArgs(args: string[]): Promise<void> {
  const parsed = parsePullArgs(args)

  if (!parsed.ref) {
    throw new Error("pull requires a <registry>/<repo>:<tag> argument")
  }

  await runPull({
    ref: parsed.ref,
    output: parsed.output ?? "./oci-layout",
    plainHttp: parsed.plainHttp,
    username: parsed.username,
    password: parsed.password,
  })
}
