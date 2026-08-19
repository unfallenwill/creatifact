import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { Command } from "commander"

import { envForConfigPath, storeDir } from "./config"
import { GEN_CONFIG_MEDIA_TYPE } from "./genPackage"
import { digestHex, REF_NAME_ANNOTATION, readIndexEntries } from "./oci"
import { addGlobalOptions } from "./util"

export interface ImagesEntry {
  ref: string
  digest: string
  size: number
  kind: "gen" | "image"
}

/** Read the shared store index; manifest blobs refine the entry kind. */
export async function listStoreImages(configPath?: string): Promise<ImagesEntry[]> {
  const dir = storeDir(envForConfigPath(configPath))
  const entries = await readIndexEntries(dir)
  const out: ImagesEntry[] = []
  for (const e of entries) {
    const ref = e.annotations?.[REF_NAME_ANNOTATION]
    if (ref === undefined) continue
    let kind: ImagesEntry["kind"] = "image"
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

export function formatImages(entries: ImagesEntry[]): string {
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

export function buildImagesCommand(): Command {
  const cmd = new Command("images").description(
    "List tags in the shared store (~/.openmmcli/store)",
  )
  return addGlobalOptions(cmd)
}

export async function runImages(opts: { configPath?: string } = {}): Promise<void> {
  const entries = await listStoreImages(opts.configPath)
  if (entries.length === 0) {
    console.log("Store is empty (build, pull, or generate to populate it)")
    return
  }
  console.log(formatImages(entries))
}
