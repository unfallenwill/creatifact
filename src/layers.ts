import { createHash } from "node:crypto"
import { createWriteStream } from "node:fs"
import { readdir, readFile, rename, stat } from "node:fs/promises"
import { join } from "node:path"
import { Readable, type Readable as ReadableStream, Writable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createGunzip, createGzip, type ZlibOptions } from "node:zlib"
import { type Entry, extract, type Pack, pack } from "tar-stream"
import { LAYER_MEDIA_TYPE, type OCIDescriptor } from "./oci"

export type FsEntry =
  | { type: "file"; data: Buffer; mode?: number }
  | { type: "symlink"; target: string }
  | { type: "dir"; mode?: number }

export type FsView = Map<string, FsEntry>

const OPAQUE_MARKER = ".wh..wh..opq"

export function normalizeTarPath(name: string): string | null {
  if (name.startsWith("/")) return null
  const parts = name.split("/")
  const out: string[] = []
  for (const part of parts) {
    if (part === "" || part === ".") continue
    if (part === "..") return null
    out.push(part)
  }
  return out.length === 0 ? null : out.join("/")
}

function basenameOf(p: string): string {
  const idx = p.lastIndexOf("/")
  return idx >= 0 ? p.slice(idx + 1) : p
}

function parentOf(p: string): string {
  const idx = p.lastIndexOf("/")
  return idx > 0 ? p.slice(0, idx) : ""
}

function deleteChildren(view: FsView, prefix: string): void {
  const prefixWithSlash = prefix ? `${prefix}/` : ""
  for (const key of view.keys()) {
    if (prefixWithSlash ? key.startsWith(prefixWithSlash) : !key.includes("/")) {
      view.delete(key)
    }
  }
}

function applyWhiteout(view: FsView, whiteoutPath: string): void {
  const parent = parentOf(whiteoutPath)
  const targetName = basenameOf(whiteoutPath).slice(".wh.".length)
  const target = parent ? `${parent}/${targetName}` : targetName
  view.delete(target)
  deleteChildren(view, target)
}

function applyOpaque(view: FsView, opaquePath: string, opaqueDirs: Set<string>): void {
  const dir = parentOf(opaquePath)
  deleteChildren(view, dir)
  if (dir && !view.has(dir)) {
    view.set(dir, { type: "dir" })
  }
  if (dir) {
    opaqueDirs.add(dir)
  }
}

function isOpaqueName(name: string): boolean {
  return name === OPAQUE_MARKER
}

function isWhiteoutName(name: string): boolean {
  return name.startsWith(".wh.") && name !== OPAQUE_MARKER
}

async function readEntry(stream: ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

async function drainEntry(stream: ReadableStream): Promise<void> {
  for await (const _chunk of stream) {
    // drop unused descriptor contents
  }
}

async function applyRegularEntry(
  view: FsView,
  entry: Entry,
  opaqueDirs: Set<string>,
): Promise<void> {
  const path = normalizeTarPath(entry.header.name)
  if (path === null) {
    console.warn(`Skipping unsafe tar path: ${entry.header.name}`)
    await drainEntry(entry)
    return
  }

  const baseName = basenameOf(path)
  if (isOpaqueName(baseName)) {
    await drainEntry(entry)
    applyOpaque(view, path, opaqueDirs)
    return
  }
  if (isWhiteoutName(baseName)) {
    await drainEntry(entry)
    applyWhiteout(view, path)
    return
  }

  const type = entry.header.type
  const mode = entry.header.mode
  if (type === "directory") {
    await drainEntry(entry)
    view.set(path, mode === undefined ? { type: "dir" } : { type: "dir", mode })
    return
  }
  if (type === "file" || type === "contiguous-file") {
    const data = await readEntry(entry)
    view.set(path, mode === undefined ? { type: "file", data } : { type: "file", data, mode })
    return
  }
  if (type === "symlink" || type === "link") {
    await drainEntry(entry)
    view.set(path, { type: "symlink", target: entry.header.linkname ?? "" })
    return
  }

  console.warn(`Skipping unsupported tar entry: ${entry.header.name} (type ${type})`)
  await drainEntry(entry)
}

export async function applyTarLayer(
  view: FsView,
  tarGz: Buffer,
  opaqueDirs: Set<string>,
): Promise<void> {
  const extractor = extract()
  const done = pipeline(Readable.from([tarGz]), createGunzip(), extractor)

  for await (const entry of extractor) {
    await applyRegularEntry(view, entry, opaqueDirs)
  }

  await done
}

export async function mergeImageLayers(
  layerBlobs: Buffer[],
): Promise<{ view: FsView; opaqueDirs: Set<string> }> {
  const view: FsView = new Map()
  const opaqueDirs = new Set<string>()
  for (const blob of layerBlobs) {
    await applyTarLayer(view, blob, opaqueDirs)
  }
  return { view, opaqueDirs }
}

function matchPath(key: string, requested: Map<string, string>): string | null {
  for (const normalized of requested.values()) {
    if (key === normalized || key.startsWith(`${normalized}/`)) {
      return normalized
    }
  }
  return null
}

function isDirFullySelected(requested: Map<string, string>, dir: string): boolean {
  for (const normalized of requested.values()) {
    if (normalized === dir || dir.startsWith(`${normalized}/`)) {
      return true
    }
  }
  return false
}

function hasSelectedChild(selected: FsView, dir: string): boolean {
  for (const key of selected.keys()) {
    if (key === dir || key.startsWith(`${dir}/`)) {
      return true
    }
  }
  return false
}

export function selectPaths(
  view: FsView,
  paths: string[],
  sourceOpaqueDirs: ReadonlySet<string>,
): { selected: FsView; opaqueDirs: Set<string> } {
  const requested = new Map<string, string>()
  for (const rawPath of paths) {
    const normalized = normalizeTarPath(rawPath)
    if (normalized === null) {
      throw new Error(`Invalid copy path: ${rawPath}`)
    }
    requested.set(rawPath, normalized)
  }

  const selected: FsView = new Map()
  const hit = new Set<string>()
  for (const [key, entry] of view) {
    const matched = matchPath(key, requested)
    if (matched !== null) {
      selected.set(key, entry)
      hit.add(matched)
    }
  }

  for (const [rawPath, normalized] of requested) {
    if (!hit.has(normalized)) {
      throw new Error(`copy path '${rawPath}' not found in source image`)
    }
  }

  const opaqueDirs = new Set<string>()
  for (const dir of sourceOpaqueDirs) {
    if (isDirFullySelected(requested, dir) && hasSelectedChild(selected, dir)) {
      opaqueDirs.add(dir)
    }
  }

  return { selected, opaqueDirs }
}

function emitEntry(tarPack: Pack, key: string, entry: FsEntry | undefined): void {
  if (entry === undefined) {
    tarPack.entry({ name: `${key}/`, type: "directory", mtime: new Date(0) })
    return
  }
  if (entry.type === "dir") {
    const mode = entry.mode
    tarPack.entry({
      name: `${key}/`,
      type: "directory",
      mtime: new Date(0),
      ...(mode === undefined ? {} : { mode }),
    })
    return
  }
  if (entry.type === "symlink") {
    tarPack.entry({ name: key, type: "symlink", linkname: entry.target, mtime: new Date(0) })
    return
  }
  const mode = entry.mode
  if (mode === undefined) {
    tarPack.entry({ name: key, size: entry.data.length, mtime: new Date(0) }, entry.data)
  } else {
    tarPack.entry({ name: key, size: entry.data.length, mode, mtime: new Date(0) }, entry.data)
  }
}

async function writeLayerBlob(tarPack: Pack, blobsDir: string): Promise<OCIDescriptor> {
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

  tarPack.finalize()
  // mtime:0 keeps gzip headers deterministic → same dir content always
  // yields the same layer digest, so the shared store can dedup rebuilds
  // (runtime gzip option; absent from ZlibOptions typings)
  const deterministicGzip = { mtime: 0 } as ZlibOptions & { mtime: number }
  await pipeline(tarPack, createGzip(deterministicGzip), hashedWriter)

  const hex = hash.digest("hex")
  const digest = `sha256:${hex}`
  await rename(tempPath, join(blobsDir, hex))

  return {
    mediaType: LAYER_MEDIA_TYPE,
    digest,
    size: totalSize,
  }
}

export async function createLayerFromView(
  view: FsView,
  opaqueDirs: Set<string>,
  blobsDir: string,
): Promise<OCIDescriptor> {
  const tarPack = pack()

  const syntheticDirs = new Set<string>()
  for (const key of view.keys()) {
    let parent = parentOf(key)
    while (parent && !view.has(parent)) {
      syntheticDirs.add(parent)
      parent = parentOf(parent)
    }
  }

  // opaque markers must sort before sibling content so they take effect
  // when the layer is applied entry by entry
  const markerKeys = [...opaqueDirs].map((dir) => `${dir}/${OPAQUE_MARKER}`)
  const sortedKeys = [...new Set([...view.keys(), ...syntheticDirs, ...markerKeys])].sort()
  for (const key of sortedKeys) {
    if (key.endsWith(`/${OPAQUE_MARKER}`)) {
      tarPack.entry({ name: key, size: 0, mtime: new Date(0) }, "")
      continue
    }
    emitEntry(tarPack, key, view.get(key))
  }

  return writeLayerBlob(tarPack, blobsDir)
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
  const tarPack = pack()

  const files = await readDirEntries(dir)
  for (const relPath of files) {
    const fullPath = join(dir, relPath)
    const content = await readFile(fullPath)
    const fileStat = await stat(fullPath)
    tarPack.entry(
      { name: relPath, mode: fileStat.mode & 0o777, size: fileStat.size, mtime: new Date(0) },
      content,
    )
  }

  return writeLayerBlob(tarPack, blobsDir)
}
