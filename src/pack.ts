import { createHash } from "node:crypto"
import { createWriteStream } from "node:fs"
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises"
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

export async function createLayerTarball(
  dir: string,
  blobsDir: string,
): Promise<OCIDescriptor> {
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
