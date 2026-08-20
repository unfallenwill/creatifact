import { existsSync, writeFileSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"

import { Command } from "commander"

import { envForConfigPath, loadConfig, storeDir } from "./config"
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
import { type BuildManifestFile, type CopyEntry, loadBuildManifest } from "./manifest"
import {
  EMPTY_CONFIG_MEDIA_TYPE,
  type LoadedImage,
  MANIFEST_MEDIA_TYPE,
  materializeBlob,
  type OCIDescriptor,
  type OCIManifest,
  readOciLayout,
  upsertStoreEntry,
  writeBlob,
  writeOciLayout,
} from "./oci"
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
  configDir?: string
}

export function buildBuildCommand(): Command {
  const cmd = new Command("build")
    .description(
      "Build an OCI image layout from a build manifest (default: ./creatifact-build.json)",
    )
    .option("-t, --tag <repo:tag>", "Image reference, e.g. org/myapp:1.0.0 (required)")
    .option(
      "--dir <path>",
      'Local directory to pack as the top layer (overrides "assets" in the manifest)',
    )
    .option("-f, --file <path>", "Build manifest path (default: ./creatifact-build.json)")
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
      "Bake the gen recipe without executing it (recipe-only package; creatifact generate <ref> runs it later)",
    )
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
  /** Skip executing the gen section (recipe-only package). */
  plan?: boolean
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
): Promise<LoadedImage> {
  const localPath = isAbsolute(spec) ? spec : join(baseDir, spec)
  if (isLocalRef(spec) || (existsSync(localPath) && (await stat(localPath)).isDirectory())) {
    if (!existsSync(localPath)) {
      throw usageError(`local layout '${spec}' not found`)
    }
    return readOciLayout(localPath)
  }

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
): Promise<OCIDescriptor[]> {
  const image = await resolveImageSource(spec, baseDir, auth)
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
): Promise<OCIDescriptor> {
  const image = await resolveImageSource(entry.from, baseDir, auth)
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

export interface BuildResult {
  digest: string
  outputDir: string
  tag: string
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
    options.from.map((spec) => inheritFromLayers(spec, process.cwd(), blobsDir, auth)),
  )
  const copied = await Promise.all(
    options.copy.map((entry) => copyLayer(entry, process.cwd(), blobsDir, auth)),
  )

  const layers: OCIDescriptor[] = [...inherited.flat(), ...copied]
  if (options.assetsDir !== undefined) {
    await validateAssetsDir(options.assetsDir)
    layers.push(await createLayerTarball(options.assetsDir, blobsDir))
  }

  // The gen section is a RUN instruction: execute it during the build and
  // bake the real artifacts as the top layer (unless --plan keeps the
  // recipe-only package). pkg:// refs in the spec resolve against the layers
  // assembled above.
  let genRun: GenRunResult | undefined
  if (options.gen !== undefined && options.plan !== true) {
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
    await upsertStoreEntry(outputDir, manifestDescriptor, options.tag)
  }

  console.log(`Built ${options.tag} → ${outputDir}${explicit ? "" : " (store)"}`)
  ok(`built ${options.tag}`)
  return { digest: manifestDescriptor.digest, outputDir, tag: options.tag }
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

export async function runBuildFromParsed(
  cliOpts: ParsedArgs,
  opts?: { configPath?: string; signal?: AbortSignal | undefined },
): Promise<BuildResult> {
  const manifestPath = cliOpts.file ?? "./creatifact-build.json"
  const loaded = await loadBuildManifest(manifestPath)

  const password = await resolvePassword(cliOpts.password, cliOpts.passwordStdin)
  const options = mergeOptions(
    { ...cliOpts, ...(password === undefined ? {} : { password }) },
    loaded.file,
  )
  options.configPath = opts?.configPath
  options.signal = opts?.signal
  if (cliOpts.plan === true) options.plan = true
  options.assetsDir = resolveLocalDir(options.assetsDir, loaded.baseDir)
  options.from = options.from.map((spec) => resolveLocalSpec(spec, loaded.baseDir))
  options.copy = options.copy.map((entry) => ({
    ...entry,
    from: resolveLocalSpec(entry.from, loaded.baseDir),
  }))

  return runBuild(options)
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
