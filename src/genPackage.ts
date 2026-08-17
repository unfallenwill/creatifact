import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GenLane } from "./gen"
import { createLayerTarball } from "./layers"
import {
  MANIFEST_MEDIA_TYPE,
  type OCIDescriptor,
  type OCIManifest,
  writeBlob,
  writeOciLayout,
} from "./oci"
import type { Artifact, Usage } from "./providers"
import { ensureOutputDirEmpty } from "./util"

/** Media type of the OCI config blob that carries a gen recipe (or a result's provenance). */
export const GEN_CONFIG_MEDIA_TYPE = "application/vnd.openmm.gen.v1+json"
export const GEN_SCHEMA_VERSION = 1

/**
 * A generation recipe baked into a package by `openmmcli package build`.
 * It never contains credentials — only provider/model ids and parameters.
 * Media references (image / frames / input) are URLs or local paths.
 */
export interface GenSpec {
  lane: GenLane
  provider?: string
  model?: string
  prompt?: string
  system?: string
  options?: Record<string, unknown>
  image?: string
  firstFrame?: string
  lastFrame?: string
  input?: string[]
}

export interface GenConfigBlob {
  schemaVersion: number
  gen: GenSpec
}

export interface GenResultMeta {
  createdAt: string
  from?: string
  usage?: Usage | undefined
  artifacts?: Array<{ name?: string; url?: string; mimeType?: string | undefined }>
}

export interface GenResultBlob {
  schemaVersion: number
  gen: GenSpec
  result: GenResultMeta
}

const GEN_LANES = new Set(["text", "image", "video", "understand", "embed"])

const KNOWN_SPEC_FIELDS = new Set([
  "lane",
  "provider",
  "model",
  "prompt",
  "system",
  "options",
  "image",
  "firstFrame",
  "lastFrame",
  "input",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function fail(path: string, field: string, message: string): never {
  const where = field === "" ? "" : `.${field}`
  throw new Error(`${path}: gen${where} ${message}`)
}

function optionalString(
  raw: Record<string, unknown>,
  path: string,
  field: string,
): string | undefined {
  const value = raw[field]
  if (value === undefined) return undefined
  if (typeof value !== "string" || value === "") {
    fail(path, field, "must be a non-empty string")
  }
  return value
}

function validateOptionsField(
  raw: Record<string, unknown>,
  path: string,
): Record<string, unknown> | undefined {
  const options = raw["options"]
  if (options === undefined) return undefined
  if (!isRecord(options)) {
    fail(path, "options", "must be an object")
  }
  return options as Record<string, unknown>
}

function validateInputField(raw: Record<string, unknown>, path: string): string[] | undefined {
  const input = raw["input"]
  if (input === undefined) return undefined
  if (typeof input === "string" && input !== "") return [input]
  if (
    Array.isArray(input) &&
    input.length > 0 &&
    input.every((v) => typeof v === "string" && v !== "")
  ) {
    return input as string[]
  }
  fail(path, "input", "must be a non-empty string or an array of non-empty strings")
}

/** Validate the `gen` section of a build manifest or a package config blob. */
export function validateGenSpec(raw: unknown, path: string): GenSpec {
  if (!isRecord(raw)) {
    fail(path, "", "must be an object")
  }

  const lane = raw["lane"]
  if (typeof lane !== "string" || !GEN_LANES.has(lane)) {
    fail(path, "lane", `must be one of ${[...GEN_LANES].join(", ")}`)
  }

  const spec: GenSpec = { lane: lane as GenLane }

  for (const field of [
    "provider",
    "model",
    "prompt",
    "system",
    "image",
    "firstFrame",
    "lastFrame",
  ] as const) {
    const value = optionalString(raw, path, field)
    if (value !== undefined) spec[field] = value
  }

  const options = validateOptionsField(raw, path)
  if (options !== undefined) spec.options = options

  const input = validateInputField(raw, path)
  if (input !== undefined) spec.input = input

  for (const key of Object.keys(raw)) {
    if (!KNOWN_SPEC_FIELDS.has(key)) {
      console.warn(`${path}: gen: unknown field '${key}' is ignored`)
    }
  }

  return spec
}

/** Parse a package config blob produced by `package build` (gen recipe). */
export function parseGenConfigBlob(data: Buffer, source: string): GenConfigBlob {
  let parsed: unknown
  try {
    parsed = JSON.parse(data.toString("utf8"))
  } catch (e) {
    throw new Error(`${source}: gen config blob is not valid JSON (${(e as Error).message})`)
  }
  if (!isRecord(parsed)) {
    throw new Error(`${source}: gen config blob must be a JSON object`)
  }
  if (parsed["schemaVersion"] !== GEN_SCHEMA_VERSION) {
    throw new Error(
      `${source}: unsupported gen config schemaVersion (expected ${GEN_SCHEMA_VERSION}, got ${String(parsed["schemaVersion"])})`,
    )
  }
  return { schemaVersion: GEN_SCHEMA_VERSION, gen: validateGenSpec(parsed["gen"], source) }
}

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
}

export interface ResultPackageOptions {
  /** Output OCI layout directory. */
  outputDir: string
  /** Reference name stored in index.json (e.g. org/myresult:1.0). */
  tag: string
  /** Input package ref for provenance. */
  fromRef?: string
  artifacts: Artifact[]
  spec: GenSpec
  usage?: Usage | undefined
  /** Overridable for deterministic tests. */
  createdAt?: string
}

/**
 * Write generated media as an OCI layout: base64 artifacts become a tar
 * layer, and a config blob records the effective gen spec + result metadata
 * so anyone can see exactly how the image/video was produced.
 */
export async function buildResultPackage(opts: ResultPackageOptions): Promise<void> {
  await ensureOutputDirEmpty(opts.outputDir)

  const blobsDir = join(opts.outputDir, "blobs", "sha256")
  await mkdir(blobsDir, { recursive: true })

  const stage = await mkdtemp(join(tmpdir(), "openmm-gen-"))
  const recorded: Array<{ name?: string; url?: string; mimeType?: string | undefined }> = []
  let layers: OCIDescriptor[] = []
  try {
    let fileCount = 0
    for (const [i, artifact] of opts.artifacts.entries()) {
      if (artifact.url !== undefined) {
        recorded.push({ url: artifact.url, mimeType: artifact.mimeType })
        continue
      }
      if (artifact.base64 === undefined) continue
      const ext = (artifact.mimeType && MIME_EXT[artifact.mimeType]) || "bin"
      const name = `artifact-${i + 1}.${ext}`
      await writeFile(join(stage, name), Buffer.from(artifact.base64, "base64"))
      recorded.push({ name, mimeType: artifact.mimeType })
      fileCount++
    }
    if (fileCount > 0) {
      layers = [await createLayerTarball(stage, blobsDir)]
    }
  } finally {
    await rm(stage, { recursive: true, force: true })
  }

  const result: GenResultMeta = {
    createdAt: opts.createdAt ?? new Date().toISOString(),
    artifacts: recorded,
  }
  if (opts.fromRef !== undefined) result.from = opts.fromRef
  if (opts.usage !== undefined) result.usage = opts.usage

  const configBlob: GenResultBlob = {
    schemaVersion: GEN_SCHEMA_VERSION,
    gen: opts.spec,
    result,
  }
  const configDescriptor = await writeBlob(
    Buffer.from(JSON.stringify(configBlob, null, 2)),
    blobsDir,
    GEN_CONFIG_MEDIA_TYPE,
  )

  const annotations: Record<string, string> = {
    "org.openmm.gen.lane": opts.spec.lane,
  }
  if (opts.spec.provider !== undefined) annotations["org.openmm.gen.provider"] = opts.spec.provider
  if (opts.spec.model !== undefined) annotations["org.openmm.gen.model"] = opts.spec.model

  const manifest: OCIManifest = {
    schemaVersion: 2,
    mediaType: MANIFEST_MEDIA_TYPE,
    config: configDescriptor,
    layers,
    annotations,
  }
  const manifestDescriptor = await writeBlob(
    Buffer.from(JSON.stringify(manifest)),
    blobsDir,
    MANIFEST_MEDIA_TYPE,
  )

  await writeOciLayout(opts.outputDir, manifestDescriptor, opts.tag)
}
