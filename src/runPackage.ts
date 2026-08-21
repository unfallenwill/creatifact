import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
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
import { type CreatedLayer, createLayerTarball, type FsView, mergeImageLayers } from "./layers"
import {
  digestHex,
  IMAGE_CONFIG_MEDIA_TYPE,
  imageConfigBuffer,
  type LoadedImage,
  MANIFEST_MEDIA_TYPE,
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

/**
 * Manifest annotation marking a creatifact package (run result or build
 * output). It is the only classification signal — readers never need to
 * extract layers to tell a creatifact package from a pulled generic image.
 */
export const PACKAGE_ANNOTATION = "org.creatifact.package"
export const PACKAGE_ANNOTATION_VALUE = "v1"

/** Package metadata record (run recipe + result), carried as this file inside the package layer. */
export const METADATA_FILE = ".creatifact/config.json"

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

/** Serialize the package metadata record ({schemaVersion, run, result?}). */
export function metadataBuffer(body: { run: RunSpec; result?: RunResultMeta }): Buffer {
  return Buffer.from(
    JSON.stringify(
      {
        schemaVersion: RUN_SCHEMA_VERSION,
        run: body.run,
        ...(body.result === undefined ? {} : { result: body.result }),
      },
      null,
      2,
    ),
  )
}

/** Parse a package metadata blob produced by `build` (run recipe). */
export function parseRunConfigBlob(data: Buffer, source: string): RunConfigBlob {
  let parsed: unknown
  try {
    parsed = JSON.parse(data.toString("utf8"))
  } catch (e) {
    throw new Error(`${source}: package metadata is not valid JSON (${(e as Error).message})`)
  }
  if (!isRecord(parsed)) {
    throw new Error(`${source}: package metadata must be a JSON object`)
  }
  if (parsed["schemaVersion"] !== RUN_SCHEMA_VERSION) {
    throw new Error(
      `${source}: unsupported package metadata schemaVersion (expected ${RUN_SCHEMA_VERSION}, got ${String(parsed["schemaVersion"])})`,
    )
  }
  return { schemaVersion: RUN_SCHEMA_VERSION, run: validateRunSpec(parsed["run"], source) }
}

/** The metadata record as read back from a package. */
export interface PackageMetadata {
  /** Raw metadata bytes — `run <ref>` re-validates via parseRunConfigBlob. */
  buffer: Buffer
  /** The run recipe, untyped; strict consumers validate via parseRunConfigBlob. */
  run: Record<string, unknown>
  /** Result record, when the package carries one (recipe-only packages omit it). */
  result?: RunResultMeta
}

function parseMetadataEntry(data: Buffer): PackageMetadata | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(data.toString("utf8"))
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || !isRecord(parsed["run"])) return undefined
  const result = parsed["result"]
  return {
    buffer: data,
    run: parsed["run"],
    ...(isRecord(result) ? { result: result as unknown as RunResultMeta } : {}),
  }
}

/** True when a manifest declares itself a creatifact package. */
export function isCreatifactPackage(manifest: OCIManifest): boolean {
  return manifest.annotations?.[PACKAGE_ANNOTATION] !== undefined
}

/** Read `.creatifact/config.json` out of a package's merged layers. Callers
 * gate on isCreatifactPackage; undefined means the file is absent or
 * unreadable — the package then degrades to a generic image. */
export async function readPackageMetadata(
  image: LoadedImage,
): Promise<PackageMetadata | undefined> {
  let view: FsView
  try {
    view = await packageFsView(image)
  } catch {
    return undefined
  }
  const entry = view.get(METADATA_FILE)
  if (entry === undefined || entry.type !== "file") return undefined
  return parseMetadataEntry(entry.data)
}

/** readPackageMetadata for a manifest whose blobs live in an OCI layout dir
 * (the shared store); undefined on any read/merge/parse failure. */
export async function readMetadataFromLayout(
  layoutDir: string,
  manifest: OCIManifest,
): Promise<PackageMetadata | undefined> {
  let view: FsView
  try {
    const layerBlobs: Buffer[] = []
    for (const layer of manifest.layers) {
      layerBlobs.push(await readFile(join(layoutDir, "blobs", "sha256", digestHex(layer.digest))))
    }
    view = layerBlobs.length === 0 ? new Map() : (await mergeImageLayers(layerBlobs)).view
  } catch {
    return undefined
  }
  const entry = view.get(METADATA_FILE)
  if (entry === undefined || entry.type !== "file") return undefined
  return parseMetadataEntry(entry.data)
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

  let view: FsView
  try {
    const manifest = JSON.parse(await readFile(blobPath(digest), "utf8")) as OCIManifest
    const layerBlobs: Buffer[] = []
    for (const layer of manifest.layers) {
      layerBlobs.push(await readFile(blobPath(layer.digest)))
    }
    view = layerBlobs.length === 0 ? new Map() : (await mergeImageLayers(layerBlobs)).view
  } catch {
    return undefined
  }

  const metadataEntry = view.get(METADATA_FILE)
  if (metadataEntry === undefined || metadataEntry.type !== "file") return undefined
  const metadata = parseMetadataEntry(metadataEntry.data)
  const artifact = (metadata?.result?.artifacts ?? []).find(
    (a) => a.url === url && a.name !== undefined,
  )
  if (metadata === undefined || artifact?.name === undefined) return undefined

  const entry = view.get(artifact.name)
  if (entry === undefined || entry.type !== "file") return undefined
  return { name: artifact.name, bytes: entry.data }
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
  /** Non-fatal download failures: the package kept the url reference only. */
  warnings: string[]
}

async function stageArtifacts(
  artifacts: Artifact[],
  stage: string,
  fetchBytes: ArtifactFetcher,
): Promise<StagedArtifacts> {
  const recorded: Array<{ name?: string; url?: string; mimeType?: string | undefined }> = []
  const warnings: string[] = []
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
      }
      continue
    }
    if (artifact.base64 === undefined) continue
    const name = `artifact-${i + 1}.${artifactExtension(artifact)}`
    await writeFile(join(stage, name), Buffer.from(artifact.base64, "base64"))
    recorded.push({ name, mimeType: artifact.mimeType })
  }
  return { recorded, warnings }
}

/** Layer file names for packed text / vector payloads. */
export const TEXT_RESULT_FILE = "text.txt"
export const VECTORS_RESULT_FILE = "vectors.json"

/**
 * Write generated media as an OCI layout consumable by any OCI client: the
 * artifacts (base64 decoded, urls downloaded) plus the `.creatifact/config.json`
 * metadata record become a tar layer, and the config blob is a standard OCI
 * image config whose rootfs.diff_ids match that layer — docker/podman can
 * pull and unpack the package like any image. Url downloads that fail degrade
 * to a url-only record plus a returned warning — the package still preserves
 * the result. Text / vector payloads (packable tasks) stage as text.txt /
 * vectors.json in the same layer so downstream steps can reference them via
 * pkg://.
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
  let warnings: string[] = []
  try {
    const staged = await stageArtifacts(
      opts.artifacts,
      stage,
      opts.fetchBytes ?? fetchArtifactBytes,
    )
    warnings = staged.warnings
    const recorded = [...staged.recorded]

    // Text / vector payloads ride the same layer as pkg://-referenceable files.
    if (opts.text !== undefined) {
      await writeFile(join(stage, TEXT_RESULT_FILE), opts.text, "utf8")
      recorded.push({ name: TEXT_RESULT_FILE, mimeType: "text/plain" })
    }
    if (opts.vectors !== undefined) {
      await writeFile(join(stage, VECTORS_RESULT_FILE), JSON.stringify(opts.vectors, null, 2))
      recorded.push({ name: VECTORS_RESULT_FILE, mimeType: "application/json" })
    }

    const result: RunResultMeta = {
      createdAt: opts.createdAt ?? new Date().toISOString(),
      artifacts: recorded,
    }
    if (opts.fromRef !== undefined) result.from = opts.fromRef
    if (opts.usage !== undefined) result.usage = opts.usage
    if (opts.text !== undefined) result.text = opts.text
    if (opts.dimensions !== undefined) result.dimensions = opts.dimensions

    const layer = await createLayerTarballWithMetadata(stage, blobsDir, {
      run: opts.spec,
      result,
    })

    const configDescriptor = await writeBlob(
      imageConfigBuffer([layer.diffId], {
        createdAt: result.createdAt,
        history: [{ createdBy: `creatifact run ${opts.spec.task}` }],
      }),
      blobsDir,
      IMAGE_CONFIG_MEDIA_TYPE,
    )
    const manifest: OCIManifest = {
      schemaVersion: 2,
      mediaType: MANIFEST_MEDIA_TYPE,
      config: configDescriptor,
      layers: [layer.descriptor],
      annotations: { [PACKAGE_ANNOTATION]: PACKAGE_ANNOTATION_VALUE },
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
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

/** Tar the staged directory plus the `.creatifact/config.json` metadata record
 * (written into the stage first) into one layer. */
export async function createLayerTarballWithMetadata(
  stage: string,
  blobsDir: string,
  body: { run: RunSpec; result?: RunResultMeta },
): Promise<CreatedLayer> {
  await mkdir(join(stage, dirname(METADATA_FILE)), { recursive: true })
  await writeFile(join(stage, METADATA_FILE), metadataBuffer(body))
  return createLayerTarball(stage, blobsDir)
}
