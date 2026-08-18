import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "./config"
import { createLayerTarball, type FsView, mergeImageLayers } from "./layers"
import {
  type LoadedImage,
  MANIFEST_MEDIA_TYPE,
  type OCIDescriptor,
  type OCIManifest,
  readOciLayout,
  writeBlob,
  writeOciLayout,
} from "./oci"
import type { Artifact, Usage } from "./providers"
import type { ImageFetchOptions } from "./pull"
import { isLocalRef } from "./refs"
import { TASKS, type GenTaskName } from "./tasks"
import { ensureOutputDirEmpty } from "./util"

export type { LoadedImage }

/** Media type of the OCI config blob that carries a gen recipe (or a result's provenance). */
export const GEN_CONFIG_MEDIA_TYPE = "application/vnd.openmm.gen.v1+json"
export const GEN_SCHEMA_VERSION = 1

/** Gen recipes cannot be the `resume` control command. */
const GEN_TASKS = new Set(Object.keys(TASKS).filter((t) => t !== "resume"))

/**
 * A generation recipe baked into a package by `openmmcli package build`.
 * Task-oriented (X2Y); never contains credentials — only provider/model ids
 * and parameters. Media references are URLs, local paths, or pkg://paths into
 * the package's own layers.
 */
export interface GenSpec {
  task: GenTaskName
  provider?: string
  model?: string
  prompt?: string
  system?: string
  images?: string[]
  firstFrame?: string
  lastFrame?: string
  inputs?: string[]
  options?: Record<string, unknown>
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

const KNOWN_SPEC_FIELDS = new Set([
  "task",
  "provider",
  "model",
  "prompt",
  "system",
  "images",
  "firstFrame",
  "lastFrame",
  "inputs",
  "options",
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

function validateStringList(
  raw: Record<string, unknown>,
  path: string,
  field: string,
): string[] | undefined {
  const value = raw[field]
  if (value === undefined) return undefined
  if (typeof value === "string" && value !== "") return [value]
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === "string" && v !== "")
  ) {
    return value as string[]
  }
  fail(path, field, "must be a non-empty string or an array of non-empty strings")
}

/** Validate the `gen` section of a build manifest or a package config blob. */
export function validateGenSpec(raw: unknown, path: string): GenSpec {
  if (!isRecord(raw)) {
    fail(path, "", "must be an object")
  }

  const task = raw["task"]
  if (typeof task !== "string" || !GEN_TASKS.has(task)) {
    fail(path, "task", `must be one of ${[...GEN_TASKS].join(", ")}`)
  }

  const spec: GenSpec = { task: task as GenTaskName }

  for (const field of [
    "provider",
    "model",
    "prompt",
    "system",
    "firstFrame",
    "lastFrame",
  ] as const) {
    const value = optionalString(raw, path, field)
    if (value !== undefined) spec[field] = value
  }

  const images = validateStringList(raw, path, "images")
  if (images !== undefined) spec.images = images
  const inputs = validateStringList(raw, path, "inputs")
  if (inputs !== undefined) spec.inputs = inputs

  const options = raw["options"]
  if (options !== undefined) {
    if (!isRecord(options)) {
      fail(path, "options", "must be an object")
    }
    spec.options = options as Record<string, unknown>
  }

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

/** Load a gen package image: a local layout path is read directly, a ref is fetched. */
export async function loadGenImage(
  ref: string,
  opts: { plainHttp: boolean; configPath?: string | undefined },
  fetchImage: (ref: string, opts: ImageFetchOptions) => Promise<LoadedImage>,
): Promise<LoadedImage> {
  if (isLocalRef(ref)) {
    return readOciLayout(ref)
  }
  return fetchImage(ref, {
    plainHttp: opts.plainHttp,
    username: undefined,
    password: undefined,
    config: loadConfig(opts.configPath),
  })
}

/** Merge every layer of a gen package into a single file view. */
export async function packageFsView(image: LoadedImage): Promise<FsView> {
  const layerBlobs: Buffer[] = []
  for (const layer of image.manifest.layers) {
    const blob = image.blobs.get(layer.digest)
    if (blob === undefined) {
      throw new Error(`layer blob ${layer.digest} is missing from the package`)
    }
    layerBlobs.push(blob)
  }
  if (layerBlobs.length === 0) return new Map()
  return (await mergeImageLayers(layerBlobs)).view
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
    "org.openmm.gen.task": opts.spec.task,
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
