import { readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { Command } from "commander"

import { envForConfigPath, storeDir } from "./config"
import { GEN_CONFIG_MEDIA_TYPE } from "./genPackage"
import {
  digestHex,
  INDEX_MEDIA_TYPE,
  type IndexEntry,
  REF_NAME_ANNOTATION,
  readIndexEntries,
} from "./oci"
import { addGlobalOptions, configOpts } from "./util"

export interface StoreEntry {
  ref: string
  digest: string
  size: number
  kind: "gen" | "image"
}

/** Read the shared store index; manifest blobs refine the entry kind. */
export async function listStoreEntries(configPath?: string): Promise<StoreEntry[]> {
  const dir = storeDir(envForConfigPath(configPath))
  const entries = await readIndexEntries(dir)
  const out: StoreEntry[] = []
  for (const e of entries) {
    const ref = e.annotations?.[REF_NAME_ANNOTATION]
    if (ref === undefined) continue
    let kind: StoreEntry["kind"] = "image"
    try {
      const manifest = JSON.parse(
        await readFile(join(dir, "blobs", "sha256", digestHex(e.digest)), "utf8"),
      ) as { config?: { mediaType?: string } }
      if (manifest.config?.mediaType === GEN_CONFIG_MEDIA_TYPE) kind = "gen"
    } catch {
      // blob missing — still list the tag with its index-level metadata
    }
    out.push({ ref, digest: e.digest, size: e.size, kind })
  }
  return out
}

export function formatStoreEntries(entries: StoreEntry[]): string {
  const rows = entries.map((e) => ({
    ref: e.ref,
    digest: e.digest.slice("sha256:".length, "sha256:".length + 12),
    size: formatSize(e.size),
    kind: e.kind,
  }))
  const refW = Math.max(8, ...rows.map((r) => r.ref.length)) + 2
  const digW = 14
  const lines = rows.map(
    (r) => `${r.ref.padEnd(refW)}${r.digest.padEnd(digW)}${r.size.padStart(9)}  ${r.kind}`,
  )
  return [
    `${"REF".padEnd(refW)}${"DIGEST".padEnd(digW)}${"SIZE".padStart(9)}  KIND`,
    ...lines,
  ].join("\n")
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}kB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/** Blobs reachable from a manifest entry: itself, its config, its layers. */
async function reachableBlobs(dir: string, entry: IndexEntry): Promise<Set<string>> {
  const set = new Set<string>([entry.digest])
  try {
    const manifest = JSON.parse(
      await readFile(join(dir, "blobs", "sha256", digestHex(entry.digest)), "utf8"),
    ) as { config?: { digest?: string }; layers?: Array<{ digest?: string }> }
    if (manifest.config?.digest !== undefined) set.add(manifest.config.digest)
    for (const l of manifest.layers ?? []) {
      if (l.digest !== undefined) set.add(l.digest)
    }
  } catch {
    // unreadable manifest — conservatively keep only its own descriptor
  }
  return set
}

export interface RemoveResult {
  untagged: string[]
  deletedBlobs: string[]
}

/**
 * Remove tags from the store and garbage-collect blobs no longer reachable
 * from any remaining entry (docker rmi semantics: shared blobs survive).
 */
export async function removeStoreRefs(refs: string[], configPath?: string): Promise<RemoveResult> {
  const dir = storeDir(envForConfigPath(configPath))
  const entries = await readIndexEntries(dir)
  const wanted = new Set(refs)
  const removed: IndexEntry[] = []
  const kept: IndexEntry[] = []
  for (const e of entries) {
    const ref = e.annotations?.[REF_NAME_ANNOTATION]
    if (ref !== undefined && wanted.has(ref)) removed.push(e)
    else kept.push(e)
  }
  const missing = refs.filter(
    (r) => !removed.some((e) => e.annotations?.[REF_NAME_ANNOTATION] === r),
  )
  if (missing.length > 0) {
    throw new Error(`tag(s) not found in store: ${missing.join(", ")}`)
  }

  // GC: delete blobs unreachable from the remaining entries
  const reachable = new Set<string>()
  for (const e of kept) {
    for (const d of await reachableBlobs(dir, e)) reachable.add(d)
  }
  const blobsDir = join(dir, "blobs", "sha256")
  const deletedBlobs: string[] = []
  try {
    for (const name of await readdir(blobsDir)) {
      const digest = `sha256:${name}`
      if (!reachable.has(digest)) {
        await rm(join(blobsDir, name))
        deletedBlobs.push(digest)
      }
    }
  } catch {
    // no blobs dir yet — nothing to collect
  }

  const index = {
    schemaVersion: 2,
    mediaType: INDEX_MEDIA_TYPE,
    manifests: kept,
  }
  await writeFile(join(dir, "index.json"), JSON.stringify(index, null, 2))

  return { untagged: refs, deletedBlobs }
}

export function buildPackageCommand(): Command {
  const pkg = new Command("package")
    .usage("<action>")
    .description("Manage packages in the shared store (~/.openmmcli/store)")
  addGlobalOptions(pkg)
  pkg.allowExcessArguments(true)

  const ls = new Command("list")
    .alias("ls")
    .description("List tags in the shared store (~/.openmmcli/store)")
  ls.action(async (options: { configDir?: string }, command: Command) => {
    await runPackageList(configOpts(command, options.configDir))
  })
  pkg.addCommand(ls)

  const rmCmd = new Command("rm")
    .description("Remove tags from the store; unreferenced blobs are deleted")
    .argument("<ref...>", "Store tag(s) to remove")
  rmCmd.action(async (refs: string[], options: { configDir?: string }, command: Command) => {
    const { configPath } = configOpts(command, options.configDir)
    const { untagged, deletedBlobs } = await removeStoreRefs(refs, configPath)
    for (const ref of untagged) console.log(`Untagged: ${ref}`)
    for (const digest of deletedBlobs) console.log(`Deleted: ${digest}`)
  })
  pkg.addCommand(rmCmd)

  pkg.action((_options, command) => {
    const action = command.args[0]
    if (action === undefined) {
      command.help()
      return
    }
    throw new Error(`unknown package action '${action}' (expected list, rm)`)
  })
  return pkg
}

export async function runPackageList(opts: { configPath?: string } = {}): Promise<void> {
  const entries = await listStoreEntries(opts.configPath)
  if (entries.length === 0) {
    console.log("Store is empty (build, pull, or generate to populate it)")
    return
  }
  console.log(formatStoreEntries(entries))
}
