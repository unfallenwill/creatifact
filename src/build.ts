import { existsSync, writeFileSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"

import { Command } from "commander"

import { defaultGenProvider, envForConfigPath, loadConfig, storeDir } from "./config"
import { runDag } from "./dag"
import { artifactBytes, artifactExtension } from "./download"
import { usageError } from "./errors"
import { ok, status } from "./format"
import { effectiveGenSpec, type GenRequest, runGenerateRequest } from "./generate"
import {
  GEN_CONFIG_MEDIA_TYPE,
  GEN_SCHEMA_VERSION,
  type GenResultMeta,
  type GenSpec,
} from "./genPackage"
import { createLayerFromView, createLayerTarball, mergeImageLayers, selectPaths } from "./layers"
import {
  type BuildManifestFile,
  type BuildStage,
  type CopyEntry,
  loadBuildManifest,
} from "./manifest"
import {
  BUILD_INPUTS_ANNOTATION,
  BUILD_PLAN_ANNOTATION,
  EMPTY_CONFIG_MEDIA_TYPE,
  type LoadedImage,
  MANIFEST_MEDIA_TYPE,
  materializeBlob,
  type OCIDescriptor,
  type OCIManifest,
  REF_NAME_ANNOTATION,
  readIndexEntries,
  readOciLayout,
  upsertStoreEntry,
  writeBlob,
  writeOciLayout,
} from "./oci"
import {
  fingerprintStage,
  hashAssetsDir,
  planDigestOf,
  readPreviousStageResult,
  resolveSourceDigest,
  type StageInputs,
  stageDependencies,
  topoOrder,
} from "./plan"
import type { Artifact } from "./providers"
import { fetchImage, type ImageFetchOptions } from "./pull"
import { isLocalRef } from "./refs"
import {
  addGlobalOptions,
  collectValue,
  ensureOutputDirEmpty,
  parseArgsWith,
  resolvePassword,
} from "./util"

export type { OCIDescriptor, OCIManifest } from "./oci"

export interface BuildCommandOptions {
  tag?: string
  dir?: string
  file?: string
  output?: string
  annotation?: string[]
  username?: string
  password?: string
  passwordStdin?: boolean
  plainHttp?: boolean
  plan?: boolean
  bake?: boolean
  force?: boolean
  configDir?: string
}

export function buildBuildCommand(): Command {
  const cmd = new Command("build")
    .description("Build an OCI image layout from a build manifest (default: ./creatifact.json)")
    .option("-t, --tag <repo:tag>", "Image reference, e.g. org/myapp:1.0.0 (required)")
    .option(
      "--dir <path>",
      'Local directory to pack as the top layer (overrides "assets" in the manifest)',
    )
    .option("-f, --file <path>", "Build manifest path (default: ./creatifact.json)")
    .option(
      "-o, --output <dir>",
      "Export a standalone OCI layout dir (default: shared store ~/.creatifact/store)",
    )
    .option(
      "--annotation <k=v>",
      "Add manifest annotation (repeatable, overrides manifest)",
      collectValue,
    )
    .option("--username <user>", "Registry username for from/copy sources")
    .option("--password <pw>", "Registry password (prefer --password-stdin)")
    .option("--password-stdin", "Read password from stdin")
    .option("--plain-http", "Use HTTP for registry sources (local registries)")
    .option(
      "--plan",
      "Print the build plan (what would run, what would be reused) without executing anything",
    )
    .option(
      "--bake",
      "Bake the gen recipe without executing it (recipe-only package; creatifact generate <ref> runs it later)",
    )
    .option("--force", "Run every stage, ignoring the store's previous fingerprints")
  return addGlobalOptions(cmd)
}

export function buildArgsFromOptions(o: BuildCommandOptions): ParsedArgs {
  const annotations: Record<string, string> = {}
  for (const item of o.annotation ?? []) {
    const eq = item.indexOf("=")
    if (eq > 0) {
      annotations[item.slice(0, eq)] = item.slice(eq + 1)
    }
  }
  return {
    ...(o.dir === undefined ? {} : { dir: o.dir }),
    ...(o.tag === undefined ? {} : { tag: o.tag }),
    ...(o.output === undefined ? {} : { output: o.output }),
    ...(o.file === undefined ? {} : { file: o.file }),
    annotations,
    ...(o.username === undefined ? {} : { username: o.username }),
    ...(o.password === undefined ? {} : { password: o.password }),
    passwordStdin: o.passwordStdin === true,
    plainHttp: o.plainHttp === true,
    ...(o.plan === true ? { plan: true } : {}),
    ...(o.bake === true ? { bake: true } : {}),
    ...(o.force === true ? { force: true } : {}),
  }
}

export interface BuildOptions {
  tag: string
  assetsDir: string | undefined
  output: string | undefined
  annotations: Record<string, string>
  from: string[]
  copy: CopyEntry[]
  gen?: GenSpec
  plainHttp: boolean
  username: string | undefined
  password: string | undefined
  /** Bake the gen recipe without executing it (recipe-only package). */
  bake?: boolean
  /** Extra annotations for this build's store entry (input fingerprint). */
  storeAnnotations?: Record<string, string>
  signal?: AbortSignal | undefined
  configPath?: string | undefined
}

export interface ParsedArgs {
  dir?: string
  tag?: string
  output?: string
  file?: string
  annotations: Record<string, string>
  username?: string
  password?: string
  passwordStdin: boolean
  plainHttp: boolean
  plan?: boolean
  bake?: boolean
  force?: boolean
}

export function parseBuildArgs(args: string[]): ParsedArgs {
  const { options } = parseArgsWith<BuildCommandOptions>(buildBuildCommand(), args)
  return buildArgsFromOptions(options)
}

export function mergeOptions(cli: ParsedArgs, manifestFile: BuildManifestFile): BuildOptions {
  const tag = cli.tag
  if (tag === undefined) {
    throw usageError("--tag is required (provide via -t/--tag)")
  }
  if (!tag.includes(":")) {
    throw usageError(`--tag must be in format 'repo:tag', got: ${tag}`)
  }

  const options: BuildOptions = {
    tag,
    assetsDir: cli.dir ?? manifestFile.assets,
    output: cli.output,
    annotations: { ...manifestFile.annotations, ...cli.annotations },
    from: manifestFile.from === undefined ? [] : [manifestFile.from].flat(),
    copy: manifestFile.copy ?? [],
    plainHttp: cli.plainHttp,
    username: cli.username,
    password: cli.password,
  }
  if (manifestFile.gen !== undefined) options.gen = manifestFile.gen
  return options
}

export async function resolveImageSource(
  spec: string,
  baseDir: string,
  auth: ImageFetchOptions,
  configPath?: string | undefined,
): Promise<LoadedImage> {
  const localPath = isAbsolute(spec) ? spec : join(baseDir, spec)
  if (isLocalRef(spec) || (existsSync(localPath) && (await stat(localPath)).isDirectory())) {
    if (!existsSync(localPath)) {
      throw usageError(`local layout '${spec}' not found`)
    }
    return readOciLayout(localPath)
  }
  // Docker-style local lookup: a tag in the shared store resolves before
  // the registry — this is what lets build stages copy from ${stage.tag}.
  const store = storeDir(envForConfigPath(configPath))
  const inStore = (await readIndexEntries(store)).some(
    (m) => m.annotations?.[REF_NAME_ANNOTATION] === spec,
  )
  if (inStore) return readOciLayout(store, spec)

  return fetchImage(spec, auth)
}

async function validateAssetsDir(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    throw usageError(`--dir '${dir}' does not exist`)
  }
  const dirStat = await stat(dir)
  if (!dirStat.isDirectory()) {
    throw usageError(`--dir '${dir}' is not a directory`)
  }
  if ((await readdir(dir)).length === 0) {
    throw usageError(`--dir '${dir}' is empty`)
  }
}

export function buildManifest(
  config: OCIDescriptor,
  layers: OCIDescriptor[],
  annotations: Record<string, string>,
): OCIManifest {
  const base: OCIManifest = {
    schemaVersion: 2,
    mediaType: MANIFEST_MEDIA_TYPE,
    config,
    layers,
  }
  if (Object.keys(annotations).length > 0) {
    return { ...base, annotations }
  }
  return base
}

async function inheritFromLayers(
  spec: string,
  baseDir: string,
  blobsDir: string,
  auth: ImageFetchOptions,
  configPath?: string | undefined,
): Promise<OCIDescriptor[]> {
  const image = await resolveImageSource(spec, baseDir, auth, configPath)
  for (const layer of image.manifest.layers) {
    const blob = image.blobs.get(layer.digest)
    if (!blob) {
      throw new Error(`Layer blob ${layer.digest} missing from source ${spec}`)
    }
    await materializeBlob(blobsDir, layer.digest, blob)
  }
  return image.manifest.layers
}

async function copyLayer(
  entry: CopyEntry,
  baseDir: string,
  blobsDir: string,
  auth: ImageFetchOptions,
  configPath?: string | undefined,
): Promise<OCIDescriptor> {
  const image = await resolveImageSource(entry.from, baseDir, auth, configPath)
  const layerBlobs: Buffer[] = []
  for (const layer of image.manifest.layers) {
    const blob = image.blobs.get(layer.digest)
    if (!blob) {
      throw new Error(`Layer blob ${layer.digest} missing from source ${entry.from}`)
    }
    layerBlobs.push(blob)
  }
  const { view, opaqueDirs } = await mergeImageLayers(layerBlobs)
  const { selected, opaqueDirs: selectedOpaque } = selectPaths(view, entry.paths, opaqueDirs)
  return createLayerFromView(selected, selectedOpaque, blobsDir)
}

/** One stage's line in the plan report (dry-run or executed build). */
export interface PlanStageReport {
  name: string
  inputsDigest: string
  status: "executed" | "reused" | "would-execute" | "would-reuse"
  digest?: string
  tag?: string
  dependencies: string[]
}

/** The plan value: stages, their input fingerprints, and the plan digest. */
export interface PlanReport {
  planDigest: string
  stages: PlanStageReport[]
}

export interface BuildResult {
  digest: string
  outputDir: string
  tag: string
  /** This build was satisfied entirely from the store (inputs unchanged). */
  reused?: boolean
  /** stages mode: per-stage results (name → build result), skipped stages. */
  stages?: Array<{
    name: string
    digest: string
    tag: string
    outputDir: string
    reused?: boolean
    inputsDigest?: string
  }>
  skipped?: Array<{ name: string; reason: string }>
  /** The resolved plan (every executed/reused stage carries its fingerprint). */
  plan?: PlanReport
  /** False for `--plan` dry runs (digest/outputDir are empty there). */
  executed?: boolean
  /** A gen stage's staged artifacts (referenceable as ${name.artifacts[N].url}). */
  artifacts?: Array<{ name?: string; url?: string; mimeType?: string | undefined }>
}

export async function runBuild(options: BuildOptions): Promise<BuildResult> {
  // Default target is the shared store (tag = pointer, blobs deduped);
  // an explicit --output exports a standalone layout (must be empty).
  const explicit = options.output !== undefined
  const outputDir =
    options.output !== undefined ? options.output : storeDir(envForConfigPath(options.configPath))
  if (explicit) {
    await ensureOutputDirEmpty(outputDir)
  }

  const blobsDir = join(outputDir, "blobs", "sha256")
  await mkdir(blobsDir, { recursive: true })

  const auth: ImageFetchOptions = {
    plainHttp: options.plainHttp,
    username: options.username,
    password: options.password,
    config: loadConfig(options.configPath),
  }

  const inherited = await Promise.all(
    options.from.map((spec) =>
      inheritFromLayers(spec, process.cwd(), blobsDir, auth, options.configPath),
    ),
  )
  const copied = await Promise.all(
    options.copy.map((entry) =>
      copyLayer(entry, process.cwd(), blobsDir, auth, options.configPath),
    ),
  )

  const layers: OCIDescriptor[] = [...inherited.flat(), ...copied]
  if (options.assetsDir !== undefined) {
    await validateAssetsDir(options.assetsDir)
    layers.push(await createLayerTarball(options.assetsDir, blobsDir))
  }

  // The gen section is a RUN instruction: execute it during the build and
  // bake the real artifacts as the top layer (unless --bake keeps the
  // recipe-only package). pkg:// refs in the spec resolve against the layers
  // assembled above.
  let genRun: GenRunResult | undefined
  if (options.gen !== undefined && options.bake !== true) {
    genRun = await runGenSection(options, layers)
    if (genRun.layer !== undefined) layers.push(genRun.layer)
  }

  const configDescriptor =
    options.gen === undefined
      ? await writeBlob(Buffer.from("{}"), blobsDir, EMPTY_CONFIG_MEDIA_TYPE)
      : await writeGenConfigBlob(
          blobsDir,
          genRun === undefined ? { gen: options.gen } : { gen: genRun.spec, result: genRun.result },
        )

  const manifest = buildManifest(configDescriptor, layers, options.annotations)
  const manifestBuffer = Buffer.from(JSON.stringify(manifest))
  const manifestDescriptor = await writeBlob(manifestBuffer, blobsDir, MANIFEST_MEDIA_TYPE)

  if (explicit) {
    await writeOciLayout(outputDir, manifestDescriptor, options.tag)
  } else {
    await upsertStoreEntry(outputDir, manifestDescriptor, options.tag, options.storeAnnotations)
  }

  ok(`built ${options.tag} → ${outputDir}${explicit ? "" : " (store)"}`)
  return {
    digest: manifestDescriptor.digest,
    outputDir,
    tag: options.tag,
    ...(genRun === undefined ? {} : { artifacts: genRun.result.artifacts }),
  }
}

/** The build's gen config blob: the spec (executed or planned) + run meta. */
async function writeGenConfigBlob(
  blobsDir: string,
  body: { gen: GenSpec; result?: GenResultMeta },
): Promise<OCIDescriptor> {
  const blob = {
    schemaVersion: GEN_SCHEMA_VERSION,
    gen: body.gen,
    ...(body.result === undefined ? {} : { result: body.result }),
  }
  return writeBlob(Buffer.from(JSON.stringify(blob, null, 2)), blobsDir, GEN_CONFIG_MEDIA_TYPE)
}

/** A build's executed gen section: its layer plus the recorded truth. */
interface GenRunResult {
  layer: OCIDescriptor | undefined
  /** The spec as actually executed (resolved provider/model). */
  spec: GenSpec
  result: GenResultMeta
}

/**
 * Execute the manifest's gen section against the layers built so far:
 * pkg:// refs resolve into those layers, the provider runs once, and the
 * artifacts land as the top layer (artifact-N.<ext>, N stable per result
 * order). The config blob records the executed spec plus a result meta so
 * the digest pins this exact run.
 */
/** Stage one artifact: bytes to disk when fetchable, else a url-only record. */
async function stageGenArtifacts(
  artifacts: Artifact[],
  stage: string,
): Promise<{
  recorded: Array<{ name?: string; url?: string; mimeType?: string | undefined }>
  warnings: string[]
}> {
  const recorded: Array<{ name?: string; url?: string; mimeType?: string | undefined }> = []
  const warnings: string[] = []
  for (const [i, artifact] of artifacts.entries()) {
    const bytes = await artifactBytes(artifact)
    if (bytes.isErr()) {
      warnings.push(`gen: artifact ${i + 1} could not be fetched (${bytes.error.message})`)
      recorded.push({
        ...(artifact.url === undefined ? {} : { url: artifact.url }),
        ...(artifact.mimeType === undefined ? {} : { mimeType: artifact.mimeType }),
      })
      continue
    }
    if (bytes.value === undefined) {
      warnings.push(`gen: artifact ${i + 1} has neither bytes nor a url`)
      continue
    }
    const name = `artifact-${i + 1}.${artifactExtension(artifact)}`
    await writeFile(join(stage, name), bytes.value)
    recorded.push({
      name,
      ...(artifact.url === undefined ? {} : { url: artifact.url }),
      ...(artifact.mimeType === undefined ? {} : { mimeType: artifact.mimeType }),
    })
  }
  return { recorded, warnings }
}

async function runGenSection(
  options: BuildOptions,
  priorLayers: OCIDescriptor[],
): Promise<GenRunResult> {
  const gen = options.gen
  if (gen === undefined) throw usageError("internal: runGenSection without a gen section")

  // pkg:// inputs come from the layers assembled so far (from/copy/assets).
  // They are local paths relative to this build's own layer set — no
  // package ref needed — so materialize against a synthesized layout view.
  const req = await genRequestFromSpec(gen, priorLayers, blobsDirOf(options))
  status(`gen: running ${req.task} (${gen.provider ?? "default provider"})`)
  const run = await runGenerateRequest(
    { ...req, noPack: true },
    {
      configPath: options.configPath,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  )
  if (run.artifacts === undefined) {
    throw usageError(
      `gen: task '${req.task}' returned no artifacts (text/embed tasks do not belong in a build gen section)`,
    )
  }

  // Stage artifacts as a layer; undownloadable urls stay url-only records
  // (same degradation as gen packages — the build stays self-describing).
  const stage = await mkdtemp(join(tmpdir(), "creatifact-buildgen-"))
  try {
    const { recorded, warnings } = await stageGenArtifacts(run.artifacts, stage)
    for (const w of warnings) console.error(`⚠ ${w}`)
    const blobsDir = blobsDirOf(options)
    const layer = recorded.some((r) => r.name !== undefined)
      ? await createLayerTarball(stage, blobsDir)
      : undefined
    return {
      layer,
      spec: effectiveGenSpec(req, run.provider ?? gen.provider ?? "", run.model ?? gen.model ?? ""),
      result: {
        createdAt: new Date().toISOString(),
        ...(run.usage === undefined ? {} : { usage: run.usage }),
        ...(recorded.length > 0 ? { artifacts: recorded } : {}),
      },
    }
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

/** The build's blob dir (store or export), created by the caller. */
function blobsDirOf(options: BuildOptions): string {
  const outputDir =
    options.output !== undefined ? options.output : storeDir(envForConfigPath(options.configPath))
  return join(outputDir, "blobs", "sha256")
}

/**
 * Turn the manifest's gen spec into a GenRequest, resolving pkg:// media
 * refs against the layers this build has assembled so far (from/copy/assets):
 * the bytes come out of the staged layer tarballs into temp files. Non-pkg
 * values pass through untouched.
 */
/** True when any media field carries a pkg:// reference. */
function specUsesPkg(gen: GenSpec): boolean {
  return (
    gen.prompt?.startsWith("pkg://") === true ||
    (gen.images ?? []).some((v) => v.startsWith("pkg://")) ||
    (gen.inputs ?? []).some((v) => v.startsWith("pkg://")) ||
    gen.firstFrame?.startsWith("pkg://") === true ||
    gen.lastFrame?.startsWith("pkg://") === true
  )
}

/** Materialize pkg:// media refs against the build's own prior layers. */
async function extractPkgRefs(
  gen: GenSpec,
  priorLayers: OCIDescriptor[],
  blobsDir: string,
): Promise<{
  prompt?: string
  images?: string[]
  inputs?: string[]
  firstFrame?: string
  lastFrame?: string
}> {
  const layerBlobs: Buffer[] = []
  for (const layer of priorLayers) {
    const blobPath = join(blobsDir, layer.digest.slice("sha256:".length))
    layerBlobs.push(await readFile(blobPath))
  }
  const { view } = await mergeImageLayers(layerBlobs)
  const tmp = await mkdtemp(join(tmpdir(), "creatifact-pkgref-"))
  const lookup = (value: string): { type: "file"; data: Buffer } => {
    const rel = value.slice("pkg://".length)
    const entry = view.get(rel)
    if (entry === undefined || entry.type !== "file") {
      throw usageError(`gen: pkg ref '${value}' not found in the build's layers (from/copy/assets)`)
    }
    return entry
  }
  const extract = (value: string): string => {
    const base = value.slice("pkg://".length).split("/").pop() ?? "file"
    const out = join(tmp, base)
    writeFileSync(out, lookup(value).data)
    return out
  }
  const extractAll = (values: string[]): string[] =>
    values.map((v) => (v.startsWith("pkg://") ? extract(v) : v))

  const out: {
    prompt?: string
    images?: string[]
    inputs?: string[]
    firstFrame?: string
    lastFrame?: string
  } = {}
  // A prompt that is exactly one pkg:// ref becomes the file's text (same
  // rule as generate <ref>): long instructions ship as layer files.
  if (gen.prompt?.startsWith("pkg://") === true)
    out.prompt = lookup(gen.prompt).data.toString("utf8")
  if (gen.images !== undefined) out.images = extractAll([...gen.images])
  if (gen.inputs !== undefined) out.inputs = extractAll([...gen.inputs])
  if (gen.firstFrame !== undefined) out.firstFrame = extract(gen.firstFrame)
  if (gen.lastFrame !== undefined) out.lastFrame = extract(gen.lastFrame)
  return out
}

async function genRequestFromSpec(
  gen: GenSpec,
  priorLayers: OCIDescriptor[],
  blobsDir: string,
): Promise<GenRequest> {
  // Internal invariant: promptFile is an authoring reference the manifest
  // loader inlines; a spec reaching execution with it set came from a
  // hand-edited package whose prompt was never resolved.
  if (gen.promptFile !== undefined) {
    throw new Error("gen.promptFile must be resolved to gen.prompt before execution")
  }
  const req: GenRequest = { task: gen.task }
  const passthrough = <K extends keyof GenSpec>(key: K, target: keyof GenRequest): void => {
    const v = gen[key]
    if (v !== undefined) {
      ;(req as unknown as Record<string, unknown>)[target as string] = v
    }
  }
  passthrough("provider", "provider")
  passthrough("model", "model")
  passthrough("system", "system")
  passthrough("options", "options")

  const media = specUsesPkg(gen)
    ? await extractPkgRefs(gen, priorLayers, blobsDir)
    : {
        ...(gen.prompt === undefined ? {} : { prompt: gen.prompt }),
        ...(gen.images === undefined ? {} : { images: [...gen.images] }),
        ...(gen.inputs === undefined ? {} : { inputs: [...gen.inputs] }),
        ...(gen.firstFrame === undefined ? {} : { firstFrame: gen.firstFrame }),
        ...(gen.lastFrame === undefined ? {} : { lastFrame: gen.lastFrame }),
      }
  return { ...req, ...media }
}

/** Build-wide context for planning and incremental reuse. */
export interface BuildContext {
  /** The shared content store (diff base for reuse decisions). */
  store: string
  defaultProvider: string | undefined
  reuse: "stale" | "never"
  force: boolean
}

export async function runBuildFromParsed(
  cliOpts: ParsedArgs,
  opts?: { configPath?: string; signal?: AbortSignal | undefined },
): Promise<BuildResult> {
  const manifestPath = cliOpts.file ?? "./creatifact.json"
  const loaded = await loadBuildManifest(manifestPath)

  const password = await resolvePassword(cliOpts.password, cliOpts.passwordStdin)
  const options = mergeOptions(
    { ...cliOpts, ...(password === undefined ? {} : { password }) },
    loaded.file,
  )
  options.configPath = opts?.configPath
  options.signal = opts?.signal
  if (cliOpts.bake === true) options.bake = true
  options.assetsDir = resolveLocalDir(options.assetsDir, loaded.baseDir)
  options.from = options.from.map((spec) => resolveLocalSpec(spec, loaded.baseDir))
  options.copy = options.copy.map((entry) => ({
    ...entry,
    from: resolveLocalSpec(entry.from, loaded.baseDir),
  }))
  const stages = loaded.file.stages?.map((stage): BuildStage => {
    const assets = resolveLocalDir(stage.assets, loaded.baseDir)
    return {
      ...stage,
      ...(assets === undefined ? {} : { assets }),
      ...(stage.from === undefined
        ? {}
        : {
            from: (Array.isArray(stage.from) ? stage.from : [stage.from]).map((spec) =>
              resolveLocalSpec(spec, loaded.baseDir),
            ),
          }),
      ...(stage.copy === undefined
        ? {}
        : {
            copy: stage.copy.map((entry) => ({
              ...entry,
              from: resolveLocalSpec(entry.from, loaded.baseDir),
            })),
          }),
    }
  })

  const config = loadConfig(options.configPath)
  const ctx: BuildContext = {
    store: storeDir(envForConfigPath(options.configPath)),
    defaultProvider: defaultGenProvider(config),
    reuse: buildReuse(config),
    force: cliOpts.force === true,
  }

  if (cliOpts.plan === true) {
    return stages !== undefined
      ? runStagesPlan(options, stages, ctx)
      : runTopLevelPlan(options, ctx)
  }
  if (stages !== undefined) return runStagesBuild(options, stages, ctx)
  return runTopLevelBuild(options, ctx)
}

/**
 * Plan → execute: resolve every stage's inputs, fingerprint them, diff
 * against the store's previous fingerprints, and skip unchanged stages.
 * The plan is a value: `--plan` prints it without executing; a real build
 * reports it in the envelope with per-stage executed/reused statuses.
 */

/** Fingerprint a top-level build (the implicit single stage). */
async function topLevelInputsDigest(options: BuildOptions, ctx: BuildContext): Promise<string> {
  const from = await Promise.all(options.from.map((spec) => resolveDigestEntry(spec, ctx.store)))
  const copy = await Promise.all(
    options.copy.map(async (entry) => {
      const resolved = await resolveDigestEntry(entry.from, ctx.store)
      return {
        from: resolved.from,
        paths: entry.paths,
        ...(resolved.digest === undefined ? {} : { digest: resolved.digest }),
      }
    }),
  )
  let assets: string | undefined
  if (options.assetsDir !== undefined) {
    await validateAssetsDir(options.assetsDir)
    assets = await hashAssetsDir(options.assetsDir)
  }
  return fingerprintStage({
    ...(ctx.defaultProvider === undefined ? {} : { defaultProvider: ctx.defaultProvider }),
    ...(options.gen === undefined ? {} : { gen: options.gen }),
    from,
    copy,
    ...(assets === undefined ? {} : { assets }),
    annotations: options.annotations,
  })
}

/** Fingerprint one resolved stage (annotations/from/copy/assets resolved). */
async function stageInputsDigest(
  stage: BuildStage,
  fields: Record<string, unknown>,
  ctx: BuildContext,
): Promise<string> {
  const fromSpecs = (fields["from"] as string[] | undefined) ?? []
  const copyEntries = (fields["copy"] as CopyEntry[] | undefined) ?? []
  const from = await Promise.all(fromSpecs.map((spec) => resolveDigestEntry(spec, ctx.store)))
  const copy = await Promise.all(
    copyEntries.map(async (entry) => {
      const resolved = await resolveDigestEntry(entry.from, ctx.store)
      return {
        from: resolved.from,
        paths: entry.paths,
        ...(resolved.digest === undefined ? {} : { digest: resolved.digest }),
      }
    }),
  )
  const assetsPath = (fields["assets"] as string | undefined) ?? stage.assets
  let assets: string | undefined
  if (assetsPath !== undefined) {
    await validateAssetsDir(assetsPath)
    assets = await hashAssetsDir(assetsPath)
  }
  const inputs: StageInputs = {
    ...(ctx.defaultProvider === undefined ? {} : { defaultProvider: ctx.defaultProvider }),
    ...(stage.gen === undefined ? {} : { gen: stage.gen }),
    from,
    copy,
    ...(assets === undefined ? {} : { assets }),
    annotations: (fields["annotations"] as Record<string, string> | undefined) ?? {},
  }
  return fingerprintStage(inputs)
}

/** Resolve one from/copy source: local layout / store tag → digest. */
async function resolveDigestEntry(
  spec: string,
  store: string,
): Promise<{ from: string; digest?: string }> {
  const digest = await resolveSourceDigest(spec, process.cwd(), store)
  return digest === undefined ? { from: spec } : { from: spec, digest }
}

interface PreviousEntry {
  digest: string
  inputsDigest?: string
}

/** The store's previous entry for one tag (the incremental diff base). */
async function previousEntry(store: string, ref: string): Promise<PreviousEntry | undefined> {
  const entry = (await readIndexEntries(store)).find(
    (m) => m.annotations?.[REF_NAME_ANNOTATION] === ref,
  )
  if (entry === undefined) return undefined
  return {
    digest: entry.digest,
    ...(entry.annotations?.[BUILD_INPUTS_ANNOTATION] === undefined
      ? {}
      : { inputsDigest: entry.annotations[BUILD_INPUTS_ANNOTATION] }),
  }
}

/** Previous store entries for a set of tags, keyed by tag. */
async function previousEntryMap(
  store: string,
  tags: string[],
): Promise<Map<string, PreviousEntry>> {
  const entries = await readIndexEntries(store)
  const map = new Map<string, PreviousEntry>()
  for (const entry of entries) {
    const ref = entry.annotations?.[REF_NAME_ANNOTATION]
    if (ref !== undefined && tags.includes(ref)) {
      map.set(ref, {
        digest: entry.digest,
        ...(entry.annotations?.[BUILD_INPUTS_ANNOTATION] === undefined
          ? {}
          : { inputsDigest: entry.annotations[BUILD_INPUTS_ANNOTATION] }),
      })
    }
  }
  return map
}

/** Assemble the plan report: per-stage fingerprints + the plan digest. */
function reportPlan(targetTag: string, stages: PlanStageReport[]): PlanReport {
  return {
    planDigest: planDigestOf(
      stages.map((s) => ({
        name: s.name,
        inputsDigest: s.inputsDigest,
        dependencies: s.dependencies,
      })),
      targetTag,
    ),
    stages,
  }
}

/** Point the build's own tag at the final stage's package (docker-style
 * alias) and record the plan digest for future plan diffing. */
async function aliasFinalEntry(
  store: string,
  tag: string,
  digest: string,
  planDigest: string,
): Promise<void> {
  const blobPath = join(store, "blobs", "sha256", digest.slice("sha256:".length))
  const size = (await stat(blobPath)).size
  await upsertStoreEntry(store, { mediaType: MANIFEST_MEDIA_TYPE, digest, size }, tag, {
    [BUILD_PLAN_ANNOTATION]: planDigest,
  })
}

/** Top-level build with incremental reuse against the store's tag entry. */
async function runTopLevelBuild(options: BuildOptions, ctx: BuildContext): Promise<BuildResult> {
  const inputsDigest = await topLevelInputsDigest(options, ctx)
  // An explicit --output exports a standalone layout: no diff base, no reuse.
  const prev =
    options.output === undefined ? await previousEntry(ctx.store, options.tag) : undefined
  const reusable = ctx.reuse === "stale" && !ctx.force && prev?.inputsDigest === inputsDigest
  if (reusable && prev !== undefined) {
    status(`build: reusing ${options.tag} (inputs unchanged)`)
    return {
      digest: prev.digest,
      outputDir: ctx.store,
      tag: options.tag,
      reused: true,
      plan: reportPlan(options.tag, [
        {
          name: options.tag,
          inputsDigest,
          status: "reused",
          digest: prev.digest,
          tag: options.tag,
          dependencies: [],
        },
      ]),
    }
  }
  const result = await runBuild({
    ...options,
    ...(options.output === undefined
      ? { storeAnnotations: { [BUILD_INPUTS_ANNOTATION]: inputsDigest } }
      : {}),
  })
  return {
    ...result,
    plan: reportPlan(options.tag, [
      {
        name: options.tag,
        inputsDigest,
        status: "executed",
        digest: result.digest,
        tag: options.tag,
        dependencies: [],
      },
    ]),
  }
}

/** `--plan` dry run for a top-level build: fingerprint + diff, nothing runs. */
async function runTopLevelPlan(options: BuildOptions, ctx: BuildContext): Promise<BuildResult> {
  const inputsDigest = await topLevelInputsDigest(options, ctx)
  const prev =
    options.output === undefined ? await previousEntry(ctx.store, options.tag) : undefined
  const reusable = ctx.reuse === "stale" && !ctx.force && prev?.inputsDigest === inputsDigest
  return {
    digest: "",
    outputDir: "",
    tag: options.tag,
    executed: false,
    plan: reportPlan(options.tag, [
      {
        name: options.tag,
        inputsDigest,
        status: reusable && prev !== undefined ? "would-reuse" : "would-execute",
        ...(reusable && prev !== undefined ? { digest: prev.digest, tag: options.tag } : {}),
        dependencies: [],
      },
    ]),
  }
}

/**
 * Orchestration mode: run the manifest's stages as a dependency graph —
 * every `${name.field}` reference in a stage's payload is a scheduling
 * edge; independent stages run concurrently (width from config). Each stage
 * is a mini build whose package lands in the store under a derived tag
 * (`<repo>/<stage>:<tag>`), so later stages reference earlier results by
 * tag/digest/url. Stages whose resolved inputs fingerprint unchanged since
 * the store's previous run are reused instead of executed (gen stages keep
 * their previous result — no re-billing). The final product is the last
 * stage's package, aliased under the `-t` tag.
 */
async function runStagesBuild(
  options: BuildOptions,
  stages: BuildStage[],
  ctx: BuildContext,
): Promise<BuildResult> {
  const names = stages.map((s) => s.name)
  const concurrency = buildConcurrency(loadConfig(options.configPath))
  const results = new Map<string, StageRef>()
  const stageOf = (name: string): BuildStage => {
    const stage = stages[names.indexOf(name)]
    if (stage === undefined) throw usageError(`internal: unknown stage '${name}'`)
    return stage
  }
  const stageTag = (stage: BuildStage): string => {
    const [repo, ver] = splitTag(options.tag)
    return `${repo}/${stage.name}:${ver}`
  }
  const payloadOf = (name: string): Record<string, unknown> => {
    const stage = stageOf(name)
    return { ...stage, annotations: stage.annotations ?? {} }
  }
  const dependencies = stageDependencies(names, payloadOf)
  const previous = await previousEntryMap(
    ctx.store,
    stages.map((s) => stageTag(s)),
  )
  const reports = new Map<string, PlanStageReport>()

  const run = await runDag(
    names,
    payloadOf,
    {
      // Fields resolve lazily inside run (the moment the stage's last
      // dependency completes, so parallel branches never wait on each
      // other's values).
      run: async (name) => {
        const stage = stageOf(name)
        const fields = resolveStageRefs(stage, results)
        const tag = stageTag(stage)
        const inputsDigest = await stageInputsDigest(stage, fields, ctx)
        const prev = previous.get(tag)
        const reusable = ctx.reuse === "stale" && !ctx.force && prev?.inputsDigest === inputsDigest
        if (reusable && prev !== undefined) {
          const prior = await readPreviousStageResult(ctx.store, prev.digest, tag)
          if (prior !== undefined) {
            status(`stage ${name}: reusing (inputs unchanged)`)
            results.set(name, prior)
            reports.set(name, {
              name,
              inputsDigest,
              status: "reused",
              digest: prev.digest,
              tag,
              dependencies: dependencies.get(name) ?? [],
            })
            return { digest: prev.digest, outputDir: ctx.store, tag, reused: true }
          }
          // Previous blobs are gone — fall through and execute.
        }
        status(`stage ${name} → ${tag}`)
        const result = await runBuild({
          ...options,
          tag,
          assetsDir: (fields["assets"] as string | undefined) ?? stage.assets,
          annotations: (fields["annotations"] as Record<string, string>) ?? {},
          from: (fields["from"] as string[]) ?? [],
          copy: (fields["copy"] as CopyEntry[]) ?? [],
          ...(stage.gen === undefined ? {} : { gen: stage.gen }),
          output: undefined,
          storeAnnotations: { [BUILD_INPUTS_ANNOTATION]: inputsDigest },
        })
        const ref = stageRefOf(tag, result)
        results.set(name, ref)
        reports.set(name, {
          name,
          inputsDigest,
          status: "executed",
          digest: result.digest,
          tag,
          dependencies: dependencies.get(name) ?? [],
        })
        return result
      },
      skipPayload: (name) => ({ name }),
    },
    {
      concurrency,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  )

  const completed = names
    .map((n) => ({ name: n, result: run.outcomes.get(n) }))
    .filter((s): s is { name: string; result: BuildResult } => s.result !== undefined)
  const last = completed.at(-1)
  if (last === undefined) throw usageError("stages produced no result")

  const plan = reportPlan(
    options.tag,
    topoOrder(names, payloadOf).flatMap((n) => {
      const report = reports.get(n)
      return report === undefined ? [] : [report]
    }),
  )

  // The final product is the last stage's package, aliased under -t.
  await aliasFinalEntry(ctx.store, options.tag, last.result.digest, plan.planDigest)

  return {
    digest: last.result.digest,
    outputDir: last.result.outputDir,
    tag: options.tag,
    stages: completed.map((s) => {
      const report = reports.get(s.name)
      return {
        name: s.name,
        digest: s.result.digest,
        tag: s.result.tag,
        outputDir: s.result.outputDir,
        ...(s.result.reused === true ? { reused: true } : {}),
        ...(report === undefined ? {} : { inputsDigest: report.inputsDigest }),
      }
    }),
    ...(run.skipped.length === 0
      ? {}
      : { skipped: run.skipped.map((s) => ({ name: s.key, reason: s.reason })) }),
    plan,
  }
}

/** `--plan` dry run for stages mode: resolve + fingerprint + diff, nothing
 * runs. Effective refs start from the store's previous results; stages
 * without a matching previous fingerprint are would-execute, and their
 * downstream refs stay unresolved placeholders (the honest prediction). */
async function runStagesPlan(
  options: BuildOptions,
  stages: BuildStage[],
  ctx: BuildContext,
): Promise<BuildResult> {
  const names = stages.map((s) => s.name)
  const stageOf = (name: string): BuildStage => {
    const stage = stages[names.indexOf(name)]
    if (stage === undefined) throw usageError(`internal: unknown stage '${name}'`)
    return stage
  }
  const stageTag = (stage: BuildStage): string => {
    const [repo, ver] = splitTag(options.tag)
    return `${repo}/${stage.name}:${ver}`
  }
  const payloadOf = (name: string): Record<string, unknown> => {
    const stage = stageOf(name)
    return { ...stage, annotations: stage.annotations ?? {} }
  }
  const dependencies = stageDependencies(names, payloadOf)
  const previous = await previousEntryMap(
    ctx.store,
    stages.map((s) => stageTag(s)),
  )
  const results = new Map<string, StageRef>()
  const reports = new Map<string, PlanStageReport>()

  for (const name of topoOrder(names, payloadOf)) {
    const stage = stageOf(name)
    const fields = resolveStageRefs(stage, results)
    const tag = stageTag(stage)
    const inputsDigest = await stageInputsDigest(stage, fields, ctx)
    const prev = previous.get(tag)
    const reusable = ctx.reuse === "stale" && !ctx.force && prev?.inputsDigest === inputsDigest
    if (reusable && prev !== undefined) {
      const prior = await readPreviousStageResult(ctx.store, prev.digest, tag)
      if (prior !== undefined) {
        results.set(name, prior)
        reports.set(name, {
          name,
          inputsDigest,
          status: "would-reuse",
          digest: prev.digest,
          tag,
          dependencies: dependencies.get(name) ?? [],
        })
        continue
      }
    }
    reports.set(name, {
      name,
      inputsDigest,
      status: "would-execute",
      dependencies: dependencies.get(name) ?? [],
    })
  }

  return {
    digest: "",
    outputDir: "",
    tag: options.tag,
    executed: false,
    plan: reportPlan(
      options.tag,
      names.flatMap((n) => {
        const report = reports.get(n)
        return report === undefined ? [] : [report]
      }),
    ),
  }
}

/** The referencable surface of one completed stage. */
interface StageRef {
  tag: string
  digest: string
  outputDir: string
  artifacts: Array<{ name?: string; url?: string; mimeType?: string | undefined }>
}

const STAGE_REF_RE =
  /\$\{([a-zA-Z][a-zA-Z0-9_]*)\.([a-zA-Z][a-zA-Z0-9_]*)(?:\[([0-9]+)\]\.([a-zA-Z][a-zA-Z0-9_]*))?\}/g

/** Resolve one `${name.field}` match against completed stage refs. */
function stageRefValue(
  match: RegExpMatchArray,
  results: ReadonlyMap<string, StageRef>,
): string | undefined {
  const ref = results.get(match[1] ?? "")
  const field = match[2] ?? ""
  if (ref === undefined) return undefined
  if (field === "tag") return ref.tag
  if (field === "digest") return ref.digest
  if (field === "outputDir") return ref.outputDir
  if (match[3] !== undefined && match[4] === "url") return ref.artifacts[Number(match[3])]?.url
  return undefined
}

/** Resolve `${name.field}` refs in a stage against completed stage results. */
function resolveStageRefs(
  stage: BuildStage,
  results: ReadonlyMap<string, StageRef>,
): Record<string, unknown> {
  const resolveString = (value: string): unknown => {
    STAGE_REF_RE.lastIndex = 0
    const whole = STAGE_REF_RE.exec(value)
    if (whole !== null && whole[0] === value) {
      return stageRefValue(whole, results) ?? value
    }
    return value.replace(STAGE_REF_RE, (m, ...groups: unknown[]) => {
      const match = [m, ...groups] as unknown as RegExpMatchArray
      return stageRefValue(match, results) ?? m
    })
  }
  const resolved = (value: unknown): unknown => {
    if (typeof value === "string") return resolveString(value)
    if (Array.isArray(value)) return value.map(resolved)
    if (typeof value === "object" && value !== null) {
      const o: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value)) o[k] = resolved(v)
      return o
    }
    return value
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(stage)) out[k] = resolved(v)
  return out
}

/** The referencable surface of one completed stage result. */
function stageRefOf(tag: string, result: BuildResult): StageRef {
  return {
    tag,
    digest: result.digest,
    outputDir: result.outputDir,
    artifacts: result.artifacts ?? [],
  }
}

/** Split a "repo:tag" reference into its parts. */
function splitTag(tag: string): [string, string] {
  const idx = tag.lastIndexOf(":")
  return idx === -1 ? [tag, "latest"] : [tag.slice(0, idx), tag.slice(idx + 1)]
}

/** Build width: config key defaults.build.concurrency (positive int, 0 = unlimited, default 4). */
function buildConcurrency(config: Record<string, unknown>): number {
  const defaults = config["defaults"]
  if (typeof defaults !== "object" || defaults === null) return 4
  const build = (defaults as Record<string, unknown>)["build"]
  if (typeof build !== "object" || build === null) return 4
  const value = (build as Record<string, unknown>)["concurrency"]
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return 4
  return value
}

/** Incremental reuse: config key defaults.build.reuse ("stale" | "never",
 * default "stale" — unchanged stages reuse their previous store result). */
function buildReuse(config: Record<string, unknown>): "stale" | "never" {
  const defaults = config["defaults"]
  if (typeof defaults !== "object" || defaults === null) return "stale"
  const build = (defaults as Record<string, unknown>)["build"]
  if (typeof build !== "object" || build === null) return "stale"
  return (build as Record<string, unknown>)["reuse"] === "never" ? "never" : "stale"
}

export async function runBuildFromArgs(
  args: string[],
  opts?: { configPath?: string },
): Promise<BuildResult> {
  return runBuildFromParsed(parseBuildArgs(args), opts)
}

function resolveLocalDir(assetsDir: string | undefined, baseDir: string): string | undefined {
  if (assetsDir === undefined) return undefined
  return isAbsolute(assetsDir) ? assetsDir : join(baseDir, assetsDir)
}

function resolveLocalSpec(spec: string, baseDir: string): string {
  if (!isLocalRef(spec)) return spec
  return isAbsolute(spec) ? spec : join(baseDir, spec)
}
