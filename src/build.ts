import { existsSync } from "node:fs"
import { mkdir, readdir, stat } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
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
import { ensureOutputDirEmpty, parseCliArgs, resolvePassword } from "./util"

export type { OCIDescriptor, OCIManifest } from "./oci"

export const BUILD_USAGE = `Usage: openmmcli build [options]

Build an OCI image layout from a build manifest (default: ./openmm-build.json).

Options:
  -t, --tag <repo:tag>   Image reference, e.g. org/myapp:1.0.0 (required)
      --dir <path>       Local directory to pack as the top layer
                         (overrides "assets" in the manifest)
  -f, --file <path>      Build manifest path (default: ./openmm-build.json)
  -o, --output <dir>     Output OCI layout directory (default: ./oci-layout)
      --annotation k=v   Add manifest annotation (repeatable, overrides manifest)
      --username <user>  Registry username for from/copy sources
      --password <pw>    Registry password (prefer --password-stdin)
      --password-stdin   Read password from stdin
      --plain-http       Use HTTP for registry sources (local registries)
  -h, --help             Show this help message`

export interface BuildOptions {
  tag: string
  assetsDir: string | undefined
  output: string
  annotations: Record<string, string>
  from: string[]
  copy: CopyEntry[]
  plainHttp: boolean
  username: string | undefined
  password: string | undefined
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

const VALUE_OPTS: Record<string, string> = {
  "--dir": "dir",
  "--tag": "tag",
  "-t": "tag",
  "--output": "output",
  "-o": "output",
  "--file": "file",
  "-f": "file",
  "--username": "username",
  "--password": "password",
  "--annotation": "annotation",
}

const BOOL_FLAGS: Record<string, string> = {
  "--password-stdin": "passwordStdin",
  "--plain-http": "plainHttp",
}

export function parseBuildArgs(args: string[]): ParsedArgs {
  const parsed = parseCliArgs(args, {
    values: VALUE_OPTS,
    flags: BOOL_FLAGS,
    repeats: new Set(["--annotation"]),
  })

  const annotations: Record<string, string> = {}
  const rawAnnotations = parsed.values["annotation"]
  const annotationList = Array.isArray(rawAnnotations) ? rawAnnotations : [rawAnnotations]
  for (const item of annotationList) {
    if (item === undefined) continue
    const eq = item.indexOf("=")
    if (eq > 0) {
      annotations[item.slice(0, eq)] = item.slice(eq + 1)
    }
  }

  const result: ParsedArgs = {
    annotations,
    passwordStdin: parsed.flags["passwordStdin"] === true,
    plainHttp: parsed.flags["plainHttp"] === true,
  }
  const dir = singleValue(parsed.values["dir"])
  if (dir !== undefined) result.dir = dir
  const tag = singleValue(parsed.values["tag"])
  if (tag !== undefined) result.tag = tag
  const output = singleValue(parsed.values["output"])
  if (output !== undefined) result.output = output
  const file = singleValue(parsed.values["file"])
  if (file !== undefined) result.file = file
  const username = singleValue(parsed.values["username"])
  if (username !== undefined) result.username = username
  const password = singleValue(parsed.values["password"])
  if (password !== undefined) result.password = password
  return result
}

function singleValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined
}

export function mergeOptions(cli: ParsedArgs, manifestFile: BuildManifestFile): BuildOptions {
  const tag = cli.tag
  if (tag === undefined) {
    throw new Error("--tag is required (provide via -t/--tag)")
  }
  if (!tag.includes(":")) {
    throw new Error(`--tag must be in format 'repo:tag', got: ${tag}`)
  }

  return {
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
}

export async function resolveImageSource(
  spec: string,
  baseDir: string,
  auth: ImageFetchOptions,
): Promise<LoadedImage> {
  const localPath = isAbsolute(spec) ? spec : join(baseDir, spec)
  if (isLocalSpec(spec) || (existsSync(localPath) && (await stat(localPath)).isDirectory())) {
    if (!existsSync(localPath)) {
      throw new Error(`local layout '${spec}' not found`)
    }
    return readOciLayout(localPath)
  }

  return fetchImage(spec, auth)
}

function isLocalSpec(spec: string): boolean {
  return spec.startsWith(".") || spec.startsWith("/")
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

export async function runBuild(options: BuildOptions): Promise<void> {
  await ensureOutputDirEmpty(options.output)

  const blobsDir = join(options.output, "blobs", "sha256")
  await mkdir(blobsDir, { recursive: true })

  const auth: ImageFetchOptions = {
    plainHttp: options.plainHttp,
    username: options.username,
    password: options.password,
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

  const configDescriptor = await writeBlob(Buffer.from("{}"), blobsDir, EMPTY_CONFIG_MEDIA_TYPE)

  const manifest = buildManifest(configDescriptor, layers, options.annotations)
  const manifestBuffer = Buffer.from(JSON.stringify(manifest))
  const manifestDescriptor = await writeBlob(manifestBuffer, blobsDir, MANIFEST_MEDIA_TYPE)

  await writeOciLayout(options.output, manifestDescriptor, options.tag)

  console.log(`Built ${options.tag} → ${options.output}`)
}

export async function runBuildFromArgs(args: string[]): Promise<void> {
  const cliOpts = parseBuildArgs(args)

  const manifestPath = cliOpts.file ?? "./openmm-build.json"
  const loaded = await loadBuildManifest(manifestPath)

  const password = await resolvePassword(cliOpts.password, cliOpts.passwordStdin)
  const options = mergeOptions(
    { ...cliOpts, ...(password === undefined ? {} : { password }) },
    loaded.file,
  )
  options.assetsDir = resolveLocalDir(options.assetsDir, loaded.baseDir)
  options.from = options.from.map((spec) => resolveLocalSpec(spec, loaded.baseDir))
  options.copy = options.copy.map((entry) => ({
    ...entry,
    from: resolveLocalSpec(entry.from, loaded.baseDir),
  }))

  await runBuild(options)
}

function resolveLocalDir(assetsDir: string | undefined, baseDir: string): string | undefined {
  if (assetsDir === undefined) return undefined
  return isAbsolute(assetsDir) ? assetsDir : join(baseDir, assetsDir)
}

function resolveLocalSpec(spec: string, baseDir: string): string {
  if (!isLocalSpec(spec)) return spec
  return isAbsolute(spec) ? spec : join(baseDir, spec)
}
