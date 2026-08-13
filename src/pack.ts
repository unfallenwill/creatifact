import { createHash } from "node:crypto"
import { createWriteStream, existsSync } from "node:fs"
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Writable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createGzip } from "node:zlib"
import { pack } from "tar-stream"

export interface OCIDescriptor {
  mediaType: string
  digest: string
  size: number
}

export interface OCIManifest {
  schemaVersion: 2
  mediaType: string
  config: OCIDescriptor
  layers: OCIDescriptor[]
  annotations?: Record<string, string>
}

export const MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json"
export const CONFIG_MEDIA_TYPE = "application/vnd.oci.image.config.v1+json"
export const LAYER_MEDIA_TYPE = "application/vnd.oci.image.layer.v1.tar+gzip"

export function buildManifest(
  config: OCIDescriptor,
  layer: OCIDescriptor,
  annotations: Record<string, string>,
): OCIManifest {
  const base: OCIManifest = {
    schemaVersion: 2,
    mediaType: MANIFEST_MEDIA_TYPE,
    config,
    layers: [layer],
  }
  if (Object.keys(annotations).length > 0) {
    return { ...base, annotations }
  }
  return base
}

export async function writeBlob(
  data: Buffer,
  blobsDir: string,
  mediaType: string,
): Promise<OCIDescriptor> {
  const hash = createHash("sha256")
  hash.update(data)
  const hex = hash.digest("hex")
  await writeFile(join(blobsDir, hex), data)
  return {
    mediaType,
    digest: `sha256:${hex}`,
    size: data.length,
  }
}

async function readDirEntries(dir: string, base = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    const relPath = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      files.push(...(await readDirEntries(fullPath, relPath)))
    } else if (entry.isFile()) {
      files.push(relPath)
    }
  }
  return files
}

export async function createLayerTarball(dir: string, blobsDir: string): Promise<OCIDescriptor> {
  const tempPath = join(blobsDir, ".tmp-layer")
  const fileStream = createWriteStream(tempPath)
  const hash = createHash("sha256")
  let totalSize = 0

  const hashedWriter = new Writable({
    write(chunk, _encoding, callback) {
      hash.update(chunk)
      totalSize += chunk.length
      fileStream.write(chunk, callback)
    },
    final(callback) {
      fileStream.end(() => callback())
    },
  })

  const tarPack = pack()

  const files = await readDirEntries(dir)
  for (const relPath of files) {
    const fullPath = join(dir, relPath)
    const content = await readFile(fullPath)
    const fileStat = await stat(fullPath)
    tarPack.entry({ name: relPath, mode: fileStat.mode & 0o777, size: fileStat.size }, content)
  }
  tarPack.finalize()

  await pipeline(tarPack, createGzip(), hashedWriter)

  const hex = hash.digest("hex")
  const digest = `sha256:${hex}`
  await rename(tempPath, join(blobsDir, hex))

  return {
    mediaType: LAYER_MEDIA_TYPE,
    digest,
    size: totalSize,
  }
}

export async function writeOciLayout(
  outputDir: string,
  manifestDescriptor: OCIDescriptor,
  ref: string,
): Promise<void> {
  await writeFile(join(outputDir, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }))

  const index = {
    schemaVersion: 2,
    manifests: [
      {
        mediaType: manifestDescriptor.mediaType,
        digest: manifestDescriptor.digest,
        size: manifestDescriptor.size,
        annotations: { "org.opencontainers.image.ref.name": ref },
      },
    ],
  }

  await writeFile(join(outputDir, "index.json"), JSON.stringify(index, null, 2))
}

export interface PackOptions {
  name: string
  dir: string
  output: string
  annotations: Record<string, string>
}

export interface ParsedArgs {
  dir?: string
  name?: string
  output?: string
  file?: string
  annotations: Record<string, string>
}

type DescriptionFile = Partial<PackOptions>

const SIMPLE_OPTS: Record<string, "dir" | "name" | "output" | "file"> = {
  "--dir": "dir",
  "--name": "name",
  "--output": "output",
  "-o": "output",
  "--file": "file",
  "-f": "file",
}

export function parsePackArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = { annotations: {} }
  let i = 0

  while (i < args.length) {
    const arg = args[i]
    if (arg === undefined) {
      i++
      continue
    }

    const optKey = SIMPLE_OPTS[arg]
    if (optKey !== undefined) {
      const v = args[++i]
      if (v !== undefined) {
        result[optKey] = v
      }
      i++
    } else if (arg === "--annotation") {
      i = consumeAnnotation(args, i, result)
    } else {
      i++
    }
  }
  return result
}

function consumeAnnotation(args: string[], i: number, result: ParsedArgs): number {
  const v = args[i + 1]
  if (v !== undefined) {
    const eq = v.indexOf("=")
    if (eq > 0) {
      result.annotations[v.slice(0, eq)] = v.slice(eq + 1)
    }
  }
  return i + 2
}

export async function loadDescriptionFile(filePath: string): Promise<DescriptionFile> {
  try {
    const content = await readFile(filePath, "utf8")
    return JSON.parse(content) as DescriptionFile
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return {}
    }
    throw new Error(`Failed to parse description file ${filePath}: ${(e as Error).message}`)
  }
}

export function mergeOptions(cli: ParsedArgs, desc: DescriptionFile): PackOptions {
  const name = cli.name ?? desc.name
  if (name === undefined) {
    throw new Error("--name is required (provide via --name or in description file)")
  }
  if (!name.includes(":")) {
    throw new Error(`--name must be in format 'repo:tag', got: ${name}`)
  }

  return {
    name,
    dir: cli.dir ?? desc.dir ?? "./plugins",
    output: cli.output ?? "./oci-layout",
    annotations: { ...desc.annotations, ...cli.annotations },
  }
}

export async function runPack(options: PackOptions): Promise<void> {
  if (!existsSync(options.dir)) {
    throw new Error(`--dir '${options.dir}' does not exist`)
  }

  const dirStat = await stat(options.dir)
  if (!dirStat.isDirectory()) {
    throw new Error(`--dir '${options.dir}' is not a directory`)
  }

  const dirEntries = await readdir(options.dir)
  if (dirEntries.length === 0) {
    throw new Error(`--dir '${options.dir}' is empty`)
  }

  if (existsSync(options.output)) {
    const outputEntries = await readdir(options.output)
    if (outputEntries.length > 0) {
      throw new Error(`--output '${options.output}' already exists and is not empty`)
    }
  }

  const blobsDir = join(options.output, "blobs", "sha256")
  await mkdir(blobsDir, { recursive: true })

  const layerDescriptor = await createLayerTarball(options.dir, blobsDir)

  const configDescriptor = await writeBlob(Buffer.from("{}"), blobsDir, CONFIG_MEDIA_TYPE)

  const manifest = buildManifest(configDescriptor, layerDescriptor, options.annotations)
  const manifestBuffer = Buffer.from(JSON.stringify(manifest))
  const manifestDescriptor = await writeBlob(manifestBuffer, blobsDir, MANIFEST_MEDIA_TYPE)

  await writeOciLayout(options.output, manifestDescriptor, options.name)

  console.log(`Packed ${options.name} → ${options.output}`)
}

export async function runPackFromArgs(args: string[]): Promise<void> {
  const cliOpts = parsePackArgs(args)

  const descFilePath = cliOpts.file ?? "./openmm-pack.json"
  const desc = await loadDescriptionFile(descFilePath)

  const options = mergeOptions(cliOpts, desc)
  await runPack(options)
}
