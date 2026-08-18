import { existsSync } from "node:fs"
import { mkdir, readdir, stat } from "node:fs/promises"
import { isAbsolute, join } from "node:path"

import { Command } from "commander"

import { loadConfig } from "./config"
import { GEN_CONFIG_MEDIA_TYPE, GEN_SCHEMA_VERSION, type GenSpec } from "./genPackage"
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
  writeBlob,
  writeOciLayout,
} from "./oci"
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
  configDir?: string
}

export function buildBuildCommand(): Command {
  const cmd = new Command("build")
    .description("Build an OCI image layout from a build manifest (default: ./openmm-build.json)")
    .option("-t, --tag <repo:tag>", "Image reference, e.g. org/myapp:1.0.0 (required)")
    .option(
      "--dir <path>",
      'Local directory to pack as the top layer (overrides "assets" in the manifest)',
    )
    .option("-f, --file <path>", "Build manifest path (default: ./openmm-build.json)")
    .option("-o, --output <dir>", "Output OCI layout directory (default: ./oci-layout)")
    .option(
      "--annotation <k=v>",
      "Add manifest annotation (repeatable, overrides manifest)",
      collectValue,
    )
    .option("--username <user>", "Registry username for from/copy sources")
    .option("--password <pw>", "Registry password (prefer --password-stdin)")
    .option("--password-stdin", "Read password from stdin")
    .option("--plain-http", "Use HTTP for registry sources (local registries)")
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
  }
}

export interface BuildOptions {
  tag: string
  assetsDir: string | undefined
  output: string
  annotations: Record<string, string>
  from: string[]
  copy: CopyEntry[]
  gen?: GenSpec
  plainHttp: boolean
  username: string | undefined
  password: string | undefined
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
}

export function parseBuildArgs(args: string[]): ParsedArgs {
  const { options } = parseArgsWith<BuildCommandOptions>(buildBuildCommand(), args)
  return buildArgsFromOptions(options)
}

export function mergeOptions(cli: ParsedArgs, manifestFile: BuildManifestFile): BuildOptions {
  const tag = cli.tag
  if (tag === undefined) {
    throw new Error("--tag is required (provide via -t/--tag)")
  }
  if (!tag.includes(":")) {
    throw new Error(`--tag must be in format 'repo:tag', got: ${tag}`)
  }

  const options: BuildOptions = {
    tag,
    assetsDir: cli.dir ?? manifestFile.assets,
    output: cli.output ?? "./oci-layout",
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
      throw new Error(`local layout '${spec}' not found`)
    }
    return readOciLayout(localPath)
  }

  return fetchImage(spec, auth)
}

async function validateAssetsDir(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    throw new Error(`--dir '${dir}' does not exist`)
  }
  const dirStat = await stat(dir)
  if (!dirStat.isDirectory()) {
    throw new Error(`--dir '${dir}' is not a directory`)
  }
  if ((await readdir(dir)).length === 0) {
    throw new Error(`--dir '${dir}' is empty`)
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
  await ensureOutputDirEmpty(options.output)

  const blobsDir = join(options.output, "blobs", "sha256")
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

  const configDescriptor =
    options.gen === undefined
      ? await writeBlob(Buffer.from("{}"), blobsDir, EMPTY_CONFIG_MEDIA_TYPE)
      : await writeBlob(
          Buffer.from(
            JSON.stringify({ schemaVersion: GEN_SCHEMA_VERSION, gen: options.gen }, null, 2),
          ),
          blobsDir,
          GEN_CONFIG_MEDIA_TYPE,
        )

  const manifest = buildManifest(configDescriptor, layers, options.annotations)
  const manifestBuffer = Buffer.from(JSON.stringify(manifest))
  const manifestDescriptor = await writeBlob(manifestBuffer, blobsDir, MANIFEST_MEDIA_TYPE)

  await writeOciLayout(options.output, manifestDescriptor, options.tag)

  console.log(`Built ${options.tag} → ${options.output}`)
  return { digest: manifestDescriptor.digest, outputDir: options.output, tag: options.tag }
}

export async function runBuildFromParsed(
  cliOpts: ParsedArgs,
  opts?: { configPath?: string },
): Promise<BuildResult> {
  const manifestPath = cliOpts.file ?? "./openmm-build.json"
  const loaded = await loadBuildManifest(manifestPath)

  const password = await resolvePassword(cliOpts.password, cliOpts.passwordStdin)
  const options = mergeOptions(
    { ...cliOpts, ...(password === undefined ? {} : { password }) },
    loaded.file,
  )
  options.configPath = opts?.configPath
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
