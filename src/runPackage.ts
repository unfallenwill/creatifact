import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { envForConfigPath, loadConfig, storeDir } from "./config"
import {
  formatIssuePath,
  type InputProvenance,
  type InputProvenanceField,
  type RunSpec,
  runSpecSchema,
  type StepProvenance,
} from "./contract"
import {
  type ArtifactFetcher,
  artifactBytes,
  artifactExtension,
  fetchArtifactBytes,
} from "./download"
import { createLayerTarball, type FsView, mergeImageLayers } from "./layers"
import {
  type LoadedImage,
  MANIFEST_MEDIA_TYPE,
  type OCIDescriptor,
  type OCIManifest,
  REF_NAME_ANNOTATION,
  readIndexEntries,
  readOciLayout,
  upsertStoreEntry,
  writeBlob,
  writeOciLayout,
} from "./oci"
import type { Artifact, Usage } from "./providers"
import type { ImageFetchOptions } from "./pull"
import { isLocalRef } from "./refs"
import { ensureOutputDirEmpty } from "./util"

export type { InputProvenance, InputProvenanceField, LoadedImage, RunSpec, StepProvenance }

/** Media type of the OCI config blob that carries a run recipe (or a result's provenance). */
export const RUN_CONFIG_MEDIA_TYPE = "application/vnd.creatifact.run.v1+json"
export const RUN_SCHEMA_VERSION = 1

export interface RunConfigBlob {
  schemaVersion: number
  run: RunSpec
}

export interface RunResultMeta {
  createdAt: string
  from?: string
  usage?: Usage | undefined
  artifacts?: Array<{ name?: string; url?: string; mimeType?: string | undefined }>
  /** Packed text tasks: the generated text, inlined for config readability. */
  text?: string | undefined
  /** Packed embed results: vector count per input. */
  dimensions?: number | undefined
}

export interface RunResultBlob {
  schemaVersion: number
  run: RunSpec
  result: RunResultMeta
}

const KNOWN_SPEC_FIELDS = new Set(Object.keys(runSpecSchema.shape))

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** promptFile is an authoring reference the manifest loader inlines; pairing it with prompt is ambiguous. */
function rejectPromptFileConflict(spec: Record<string, unknown>, path: string): void {
  if (spec["prompt"] !== undefined && spec["promptFile"] !== undefined) {
    throw new Error(`${path}: run.promptFile use either prompt or promptFile, not both`)
  }
}

/**
 * Validate the `run` section of a build manifest or a package config blob.
 * Constraints live in contract.ts's runSpecSchema; this wrapper keeps the
 * historical error format (`<path>: run.<field> <message>`) and the two
 * normalizations the schema stays silent about: a bare string list value
 * wraps into an array, and an all-empty promptRef collapses to nothing.
 */
export function validateRunSpec(raw: unknown, path: string): RunSpec {
  if (!isRecord(raw)) {
    throw new Error(`${path}: run must be an object`)
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_SPEC_FIELDS.has(key)) {
      console.warn(`${path}: run: unknown field '${key}' is ignored`)
    }
  }
  const result = runSpecSchema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw new Error(
      issue === undefined
        ? `${path}: run failed validation`
        : `${path}: run.${formatIssuePath(issue.path)} ${issue.message}`,
    )
  }
  // looseObject passthrough keeps unknown keys; the historical contract
  // drops them (they were warned about above), so pick known keys only.
  const parsed = result.data
  const spec: Record<string, unknown> = {}
  for (const key of KNOWN_SPEC_FIELDS) {
    if (parsed[key] !== undefined) spec[key] = parsed[key]
  }
  rejectPromptFileConflict(spec, path)
  if (typeof spec["images"] === "string") spec["images"] = [spec["images"]]
  if (typeof spec["inputs"] === "string") spec["inputs"] = [spec["inputs"]]
  const promptRef = spec["promptRef"]
  if (typeof promptRef === "object" && promptRef !== null && Object.keys(promptRef).length === 0) {
    delete spec["promptRef"]
  }
  // images/inputs are normalized above (string variants eliminated); the
  // constraints themselves live in contract.ts's runSpecSchema.
  return spec as RunSpec
}

/** Parse a package config blob produced by `build` (run recipe). */
export function parseRunConfigBlob(data: Buffer, source: string): RunConfigBlob {
  let parsed: unknown
  try {
    parsed = JSON.parse(data.toString("utf8"))
  } catch (e) {
    throw new Error(`${source}: run config blob is not valid JSON (${(e as Error).message})`)
  }
  if (!isRecord(parsed)) {
    throw new Error(`${source}: run config blob must be a JSON object`)
  }
  if (parsed["schemaVersion"] !== RUN_SCHEMA_VERSION) {
    throw new Error(
      `${source}: unsupported run config schemaVersion (expected ${RUN_SCHEMA_VERSION}, got ${String(parsed["schemaVersion"])})`,
    )
  }
  return { schemaVersion: RUN_SCHEMA_VERSION, run: validateRunSpec(parsed["run"], source) }
}

/**
 * Load a run package image: a local layout path is read directly, a store
 * tag is resolved from the shared store index, anything else is fetched from
 * a registry.
 */
export async function loadRunImage(
  ref: string,
  opts: { plainHttp: boolean; configPath?: string | undefined },
  fetchImage: (ref: string, opts: ImageFetchOptions) => Promise<LoadedImage>,
): Promise<LoadedImage> {
  if (isLocalRef(ref)) {
    return readOciLayout(ref)
  }
  // Store tags first (docker-style local image lookup), then the registry.
  const store = storeDir(envForConfigPath(opts.configPath))
  const inStore = (await readIndexEntries(store)).some(
    (m) => m.annotations?.[REF_NAME_ANNOTATION] === ref,
  )
  if (inStore) {
    return readOciLayout(store, ref)
  }
  return fetchImage(ref, {
    plainHttp: opts.plainHttp,
    username: undefined,
    password: undefined,
    config: loadConfig(opts.configPath),
  })
}

/** Merge every layer of a run package into a single file view. */
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

/** A stored artifact located by package digest + url match. */
export interface StoredArtifact {
  name: string
  bytes: Buffer
}

/**
 * Find an artifact's bytes in the shared store by content-addressed package
 * digest plus its original URL — the rerun fallback for expired provider CDN
 * links. Returns undefined whenever the package (or a matching artifact) is
 * not in the store; callers then surface the original provider error instead.
 */
export async function artifactFromStore(
  digest: string,
  url: string,
  opts: { configPath?: string | undefined } = {},
): Promise<StoredArtifact | undefined> {
  const store = storeDir(envForConfigPath(opts.configPath))
  const blobPath = (d: string): string => join(store, "blobs", "sha256", d.slice(7))

  let inStore = false
  try {
    inStore = (await readIndexEntries(store)).some((m) => m.digest === digest)
  } catch {
    return undefined
  }
  if (!inStore) return undefined

  let manifest: OCIManifest
  let config: RunResultBlob
  try {
    manifest = JSON.parse(await readFile(blobPath(digest), "utf8")) as OCIManifest
    config = JSON.parse(await readFile(blobPath(manifest.config.digest), "utf8")) as RunResultBlob
  } catch {
    return undefined
  }
  const artifact = (config.result.artifacts ?? []).find(
    (a) => a.url === url && a.name !== undefined,
  )
  if (artifact?.name === undefined) return undefined

  try {
    const layerBlobs: Buffer[] = []
    for (const layer of manifest.layers) {
      layerBlobs.push(await readFile(blobPath(layer.digest)))
    }
    if (layerBlobs.length === 0) return undefined
    const { view } = await mergeImageLayers(layerBlobs)
    const entry = view.get(artifact.name)
    if (entry === undefined || entry.type !== "file") return undefined
    return { name: artifact.name, bytes: entry.data }
  } catch {
    return undefined
  }
}

export interface ResultPackageOptions {
  /** Layout dir: shared store (with store:true) or standalone export dir. */
  outputDir: string
  /** Reference name stored in index.json (e.g. org/myresult:1.0). */
  tag: string
  /** Store mode: dedup blobs, replace the index entry with the same tag. */
  store?: boolean
  /** Input package ref for provenance. */
  fromRef?: string
  artifacts: Artifact[]
  spec: RunSpec
  usage?: Usage | undefined
  /** Packed text payload (text2text / image2text / video2text). */
  text?: string | undefined
  /** Packed embed vectors. */
  vectors?: number[][] | undefined
  /** Packed embed dimension count. */
  dimensions?: number | undefined
  /** Overridable for deterministic tests. */
  createdAt?: string
  /** Artifact downloader; defaults to real HTTP (injectable for tests). */
  fetchBytes?: ArtifactFetcher
}

export interface StagedArtifacts {
  recorded: Array<{ name?: string; url?: string; mimeType?: string | undefined }>
  layers: OCIDescriptor[]
  /** Non-fatal download failures: the package kept the url reference only. */
  warnings: string[]
}

async function stageArtifacts(
  artifacts: Artifact[],
  stage: string,
  blobsDir: string,
  fetchBytes: ArtifactFetcher,
): Promise<StagedArtifacts> {
  const recorded: Array<{ name?: string; url?: string; mimeType?: string | undefined }> = []
  const warnings: string[] = []
  let fileCount = 0
  for (const [i, artifact] of artifacts.entries()) {
    if (artifact.url !== undefined) {
      const bytes = await artifactBytes(artifact, fetchBytes)
      if (bytes.isErr()) {
        warnings.push(
          `could not download ${artifact.url} (${bytes.error.message}); ` +
            "the package records the url only and is not self-contained for this artifact",
        )
        recorded.push({ url: artifact.url, mimeType: artifact.mimeType })
        continue
      }
      if (bytes.value !== undefined) {
        const name = `artifact-${i + 1}.${artifactExtension(artifact)}`
        await writeFile(join(stage, name), bytes.value)
        recorded.push({ name, url: artifact.url, mimeType: artifact.mimeType })
        fileCount++
      }
      continue
    }
    if (artifact.base64 === undefined) continue
    const name = `artifact-${i + 1}.${artifactExtension(artifact)}`
    await writeFile(join(stage, name), Buffer.from(artifact.base64, "base64"))
    recorded.push({ name, mimeType: artifact.mimeType })
    fileCount++
  }
  return {
    recorded,
    layers: fileCount > 0 ? [await createLayerTarball(stage, blobsDir)] : [],
    warnings,
  }
}

/** Layer file names for packed text / vector payloads. */
export const TEXT_RESULT_FILE = "text.txt"
export const VECTORS_RESULT_FILE = "vectors.json"

/**
 * Write generated media as an OCI layout: artifacts (base64 decoded, urls
 * downloaded) become a tar layer, and a config blob records the effective
 * run spec + result metadata so anyone can see exactly how the
 * image/video was produced. Url downloads that fail degrade to a url-only
 * record plus a returned warning — the package still preserves the result.
 * Text / vector payloads (packable tasks) stage as text.txt / vectors.json
 * in the same layer so downstream steps can reference them via pkg://.
 */
export async function buildResultPackage(opts: ResultPackageOptions): Promise<{
  digest: string
  warnings: string[]
}> {
  if (opts.store !== true) {
    await ensureOutputDirEmpty(opts.outputDir)
  }

  const blobsDir = join(opts.outputDir, "blobs", "sha256")
  await mkdir(blobsDir, { recursive: true })

  const stage = await mkdtemp(join(tmpdir(), "creatifact-run-"))
  let recorded: Array<{ name?: string; url?: string; mimeType?: string | undefined }> = []
  let layers: OCIDescriptor[] = []
  let warnings: string[] = []
  try {
    const staged = await stageArtifacts(
      opts.artifacts,
      stage,
      blobsDir,
      opts.fetchBytes ?? fetchArtifactBytes,
    )
    recorded = staged.recorded
    layers = staged.layers
    warnings = staged.warnings

    // Text / vector payloads ride the same layer as pkg://-referenceable
    // files; adding them to the stage requires one (re)build of the tarball.
    let payloadAdded = false
    if (opts.text !== undefined) {
      await writeFile(join(stage, TEXT_RESULT_FILE), opts.text, "utf8")
      recorded.push({ name: TEXT_RESULT_FILE, mimeType: "text/plain" })
      payloadAdded = true
    }
    if (opts.vectors !== undefined) {
      await writeFile(join(stage, VECTORS_RESULT_FILE), JSON.stringify(opts.vectors, null, 2))
      recorded.push({ name: VECTORS_RESULT_FILE, mimeType: "application/json" })
      payloadAdded = true
    }
    if (payloadAdded) {
      layers = [await createLayerTarball(stage, blobsDir)]
    }
  } finally {
    await rm(stage, { recursive: true, force: true })
  }

  const result: RunResultMeta = {
    createdAt: opts.createdAt ?? new Date().toISOString(),
    artifacts: recorded,
  }
  if (opts.fromRef !== undefined) result.from = opts.fromRef
  if (opts.usage !== undefined) result.usage = opts.usage
  if (opts.text !== undefined) result.text = opts.text
  if (opts.dimensions !== undefined) result.dimensions = opts.dimensions

  const configBlob: RunResultBlob = {
    schemaVersion: RUN_SCHEMA_VERSION,
    run: opts.spec,
    result,
  }
  const configDescriptor = await writeBlob(
    Buffer.from(JSON.stringify(configBlob, null, 2)),
    blobsDir,
    RUN_CONFIG_MEDIA_TYPE,
  )

  const annotations: Record<string, string> = {
    "org.creatifact.run.task": opts.spec.task,
  }
  if (opts.spec.provider !== undefined) {
    annotations["org.creatifact.run.provider"] = opts.spec.provider
  }
  if (opts.spec.model !== undefined) annotations["org.creatifact.run.model"] = opts.spec.model

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

  if (opts.store === true) {
    await upsertStoreEntry(opts.outputDir, manifestDescriptor, opts.tag)
  } else {
    await writeOciLayout(opts.outputDir, manifestDescriptor, opts.tag)
  }
  return { digest: manifestDescriptor.digest, warnings }
}
