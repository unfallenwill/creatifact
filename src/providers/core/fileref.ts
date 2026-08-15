import { readFile, stat } from "node:fs/promises"
import type { FileRef } from "./types"

/** Guard against blocking the event loop with huge base64 payloads inline. */
export const MAX_INLINE_BYTES = 50 * 1024 * 1024

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
}

export function isUrlRef(ref: FileRef): ref is { url: string } {
  return "url" in ref
}

export function isBase64Ref(ref: FileRef): ref is { base64: string } {
  return "base64" in ref
}

export function isLocalPathRef(ref: FileRef): ref is { localPath: string } {
  return "localPath" in ref
}

function mimeFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  return EXT_MIME[ext] ?? "application/octet-stream"
}

function guardSize(bytes: number, source: string): void {
  if (bytes > MAX_INLINE_BYTES) {
    throw new Error(
      `file too large to inline (${bytes} bytes > ${MAX_INLINE_BYTES}): ${source}. ` +
        "Upload it and pass a { url } FileRef instead",
    )
  }
}

/**
 * Normalize any FileRef into a URL the providers accept (plain URL or data
 * URI). `mimeHint` overrides the inferred mime type (default: guessed from
 * the local file extension, or application/octet-stream).
 */
export async function toUrlRef(ref: FileRef, mimeHint?: string): Promise<{ url: string }> {
  if (isUrlRef(ref)) return { url: ref.url }
  if (isBase64Ref(ref)) {
    guardSize(Math.floor((ref.base64.length * 3) / 4), "base64 FileRef")
    const mime = mimeHint ?? "application/octet-stream"
    return { url: `data:${mime};base64,${ref.base64}` }
  }
  const { size } = await stat(ref.localPath)
  guardSize(size, ref.localPath)
  const data = await readFile(ref.localPath)
  const mime = mimeHint ?? mimeFromPath(ref.localPath)
  return { url: `data:${mime};base64,${data.toString("base64")}` }
}
