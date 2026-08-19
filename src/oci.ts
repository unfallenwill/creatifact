import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

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
export const INDEX_MEDIA_TYPE = "application/vnd.oci.image.index.v1+json"
export const EMPTY_CONFIG_MEDIA_TYPE = "application/vnd.oci.empty.v1+json"
export const LAYER_MEDIA_TYPE = "application/vnd.oci.image.layer.v1.tar+gzip"

/** OCI annotation carrying the tag on an index entry. */
export const REF_NAME_ANNOTATION = "org.opencontainers.image.ref.name"

export interface LoadedImage {
  manifestDescriptor: OCIDescriptor
  manifest: OCIManifest
  manifestBuffer: Buffer
  refName: string | undefined
  blobs: Map<string, Buffer>
}

export interface ParsedRef {
  registry: string
  repository: string
  tag: string
}

export function parseRef(ref: string): ParsedRef {
  let registry = "docker.io"
  let rest = ref

  const slashIdx = ref.indexOf("/")
  if (slashIdx > 0) {
    const firstPart = ref.slice(0, slashIdx)
    if (firstPart.includes(".") || firstPart.includes(":") || firstPart === "localhost") {
      registry = firstPart
      rest = ref.slice(slashIdx + 1)
    }
  }

  const colonIdx = rest.lastIndexOf(":")
  let tag = "latest"
  let repository = rest
  if (colonIdx > 0) {
    tag = rest.slice(colonIdx + 1)
    repository = rest.slice(0, colonIdx)
  }

  return { registry, repository, tag }
}

export function digestHex(digest: string): string {
  return digest.slice("sha256:".length)
}

export async function writeBlob(
  data: Buffer,
  blobsDir: string,
  mediaType: string,
): Promise<OCIDescriptor> {
  const hash = createHash("sha256")
  hash.update(data)
  const hex = hash.digest("hex")
  // Content-addressed: same digest means same bytes — skip existing so shared
  // stores dedup blobs across images (docker-style global content store).
  const dest = join(blobsDir, hex)
  if (!existsSync(dest)) {
    await writeFile(dest, data)
  }
  return {
    mediaType,
    digest: `sha256:${hex}`,
    size: data.length,
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
    mediaType: INDEX_MEDIA_TYPE,
    manifests: [
      {
        mediaType: manifestDescriptor.mediaType,
        digest: manifestDescriptor.digest,
        size: manifestDescriptor.size,
        annotations: { [REF_NAME_ANNOTATION]: ref },
      },
    ],
  }

  await writeFile(join(outputDir, "index.json"), JSON.stringify(index, null, 2))
}

export interface IndexEntry extends OCIDescriptor {
  annotations?: Record<string, string>
}

/** Read index.json manifests from a layout dir; [] when absent. */
export async function readIndexEntries(layoutDir: string): Promise<IndexEntry[]> {
  const indexPath = join(layoutDir, "index.json")
  if (!existsSync(indexPath)) return []
  try {
    const index = JSON.parse(await readFile(indexPath, "utf8")) as { manifests?: IndexEntry[] }
    return Array.isArray(index.manifests) ? index.manifests : []
  } catch {
    return []
  }
}

/**
 * Upsert a tagged manifest into a shared store layout (docker-style: the tag
 * is a pointer). Blobs are never deleted — replacing a tag just repoints it;
 * unreferenced blobs may be pruned later. Keeps every other tag's entry.
 */
export async function upsertStoreEntry(
  storeDir: string,
  manifestDescriptor: OCIDescriptor,
  ref: string,
): Promise<void> {
  const marker = join(storeDir, "oci-layout")
  if (!existsSync(marker)) {
    await mkdir(storeDir, { recursive: true })
    await writeFile(marker, JSON.stringify({ imageLayoutVersion: "1.0.0" }))
  }

  const entry: IndexEntry = {
    mediaType: manifestDescriptor.mediaType,
    digest: manifestDescriptor.digest,
    size: manifestDescriptor.size,
    annotations: { [REF_NAME_ANNOTATION]: ref },
  }
  const others = (await readIndexEntries(storeDir)).filter(
    (m) => m.annotations?.[REF_NAME_ANNOTATION] !== ref,
  )
  const index = {
    schemaVersion: 2,
    mediaType: INDEX_MEDIA_TYPE,
    manifests: [...others, entry],
  }
  await writeFile(join(storeDir, "index.json"), JSON.stringify(index, null, 2))
}

export async function readOciLayout(
  layoutDir: string,
  preferredRef?: string,
): Promise<LoadedImage> {
  const indexRaw = await readFile(join(layoutDir, "index.json"), "utf8")
  const index = JSON.parse(indexRaw) as {
    manifests: Array<OCIDescriptor & { annotations?: Record<string, string> }>
  }
  const all = index.manifests
  // A shared store holds many tags; prefer the requested one, else first entry
  const manifestEntry =
    (preferredRef !== undefined &&
      all.find((m) => m.annotations?.[REF_NAME_ANNOTATION] === preferredRef)) ||
    all[0]
  if (!manifestEntry) {
    throw new Error("No manifest found in index.json")
  }
  if (
    preferredRef !== undefined &&
    manifestEntry.annotations?.[REF_NAME_ANNOTATION] !== preferredRef
  ) {
    throw new Error(
      `tag '${preferredRef}' not found in ${layoutDir}; build or pull it first, or pass --layout`,
    )
  }

  const manifestDigest = manifestEntry.digest
  const manifestBuffer = await readFile(
    join(layoutDir, "blobs", "sha256", digestHex(manifestDigest)),
  )
  const manifest = JSON.parse(manifestBuffer.toString("utf8")) as OCIManifest

  const blobs = new Map<string, Buffer>()
  const allDescriptors = [manifest.config, ...manifest.layers]
  for (const desc of allDescriptors) {
    const blobData = await readFile(join(layoutDir, "blobs", "sha256", digestHex(desc.digest)))
    blobs.set(desc.digest, blobData)
  }

  return {
    manifestDescriptor: {
      mediaType: manifestEntry.mediaType,
      digest: manifestEntry.digest,
      size: manifestEntry.size,
    },
    manifest,
    manifestBuffer,
    refName: manifestEntry.annotations?.[REF_NAME_ANNOTATION],
    blobs,
  }
}

export interface SaveLayoutInput {
  manifest: OCIManifest
  manifestData: string
  manifestDigest: string
  blobs: Map<string, Buffer>
  ref: string
}

export async function saveLayout(outputDir: string, layout: SaveLayoutInput): Promise<void> {
  const { manifest, manifestData, manifestDigest, blobs, ref } = layout
  const blobsDir = join(outputDir, "blobs", "sha256")
  await mkdir(blobsDir, { recursive: true })

  for (const [digest, data] of blobs) {
    await materializeBlob(blobsDir, digest, data)
  }
  await materializeBlob(blobsDir, manifestDigest, Buffer.from(manifestData, "utf8"))

  await writeOciLayout(
    outputDir,
    {
      mediaType: manifest.mediaType,
      digest: manifestDigest,
      size: Buffer.byteLength(manifestData),
    },
    ref,
  )
}

export async function materializeBlob(
  blobsDir: string,
  digest: string,
  data: Buffer,
): Promise<void> {
  const dest = join(blobsDir, digestHex(digest))
  if (existsSync(dest)) return
  await writeFile(dest, data)
}
