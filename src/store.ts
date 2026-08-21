import { readdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"

import { Command } from "commander"

import { parseBrowserPort, serveStoreBrowser } from "./browse"
import { envForConfigPath, storeDir } from "./config"
import { usageError } from "./errors"
import { GEN_CONFIG_MEDIA_TYPE } from "./genPackage"
import {
  digestHex,
  type IndexEntry,
  REF_NAME_ANNOTATION,
  readIndexEntries,
  withIndexLock,
  writeIndexAtomic,
} from "./oci"
import { emitResult } from "./output"
import { addGlobalOptions, configOpts, prettyOpts } from "./util"

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

export interface TagResult {
  source: string
  target: string
}

/**
 * Point a second store ref at an existing tag's manifest (docker tag
 * semantics): one more index entry, no blob copies; removeStoreRefs GCs.
 */
export async function tagStoreRef(
  source: string,
  target: string,
  configPath?: string,
): Promise<TagResult> {
  const dir = storeDir(envForConfigPath(configPath))
  await withIndexLock(dir, async () => {
    const entries = await readIndexEntries(dir)
    const src = entries.find((e) => e.annotations?.[REF_NAME_ANNOTATION] === source)
    if (src === undefined) {
      throw usageError(`tag '${source}' not found in store`)
    }
    const exists = entries.some((e) => e.annotations?.[REF_NAME_ANNOTATION] === target)
    if (exists) {
      throw usageError(`tag '${target}' already exists in store`)
    }
    const { [REF_NAME_ANNOTATION]: _ref, ...annotations } = src.annotations ?? {}
    void _ref
    await writeIndexAtomic(dir, [
      ...entries,
      { ...src, annotations: { [REF_NAME_ANNOTATION]: target, ...annotations } },
    ])
  })
  return { source, target }
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
  return withIndexLock(dir, async () => {
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
      throw usageError(`tag(s) not found in store: ${missing.join(", ")}`)
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

    await writeIndexAtomic(dir, kept)

    return { untagged: refs, deletedBlobs }
  })
}

export function buildTagCommand(): Command {
  return new Command("tag")
    .description("Create a store tag pointing at an existing tag (docker tag semantics)")
    .argument("<source>", "Existing store tag")
    .argument("<target>", "New store tag")
    .action(
      async (source: string, target: string, options: { configDir?: string }, command: Command) => {
        const { configPath } = configOpts(command, options.configDir)
        const result = await tagStoreRef(source, target, configPath)
        emitResult("package.tag", result, prettyOpts(command))
      },
    )
}

export function buildPackageCommand(): Command {
  const pkg = new Command("package")
    .usage("[action] [options]")
    .description("Manage packages in the shared store (~/.creatifact/store)")
  addGlobalOptions(pkg)
  pkg.allowExcessArguments(true)

  const ls = new Command("list")
    .alias("ls")
    .description("List tags in the shared store (~/.creatifact/store)")
  ls.action(async (options: { configDir?: string }, command: Command) => {
    const entries = await listStoreEntries(configOpts(command, options.configDir).configPath)
    emitResult("package.list", { entries }, prettyOpts(command))
  })
  pkg.addCommand(ls)

  const serve = new Command("serve")
    .description(
      "Serve the store web UI on 127.0.0.1 (waterfall gallery, package contents, delete); runs until Ctrl-C",
    )
    .option("--browser", "Open the web UI in the default browser once the server is up")
    .option("--port <port>", "Port to listen on (default: a random free port)")
  serve.action(
    async (options: { configDir?: string; browser?: boolean; port?: string }, command: Command) => {
      const { configPath } = configOpts(command, options.configDir)
      await serveStoreBrowser({
        configPath,
        port: parseBrowserPort(options.port),
        open: options.browser === true,
        pretty: prettyOpts(command).pretty,
        removeRefs: (refs) => removeStoreRefs(refs, configPath),
      })
    },
  )
  pkg.addCommand(serve)

  const rmCmd = new Command("rm")
    .description("Remove tags from the store; unreferenced blobs are deleted")
    .argument("<ref...>", "Store tag(s) to remove")
  rmCmd.action(async (refs: string[], options: { configDir?: string }, command: Command) => {
    const { configPath } = configOpts(command, options.configDir)
    const result = await removeStoreRefs(refs, configPath)
    emitResult("package.rm", result, prettyOpts(command))
  })
  pkg.addCommand(rmCmd)

  pkg.action((_options, command) => {
    const action = command.args[0]
    if (action === undefined) {
      command.help()
      return
    }
    throw usageError(`unknown package action '${action}' (expected list, serve, rm, tag)`)
  })
  return pkg
}

/** List the shared store's tags as data (empty list when the store is empty). */
export async function runPackageList(opts: { configPath?: string } = {}): Promise<{
  entries: StoreEntry[]
}> {
  return { entries: await listStoreEntries(opts.configPath) }
}
