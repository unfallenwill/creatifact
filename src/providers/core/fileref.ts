import { readFileSync } from "node:fs"
import type { FileRef } from "./types"

export function isUrlRef(ref: FileRef): ref is { url: string } {
  return "url" in ref
}

export function isBase64Ref(ref: FileRef): ref is { base64: string } {
  return "base64" in ref
}

export function isLocalPathRef(ref: FileRef): ref is { localPath: string } {
  return "localPath" in ref
}

export function toUrlRef(ref: FileRef): { url: string } {
  if (isUrlRef(ref)) return ref
  if (isBase64Ref(ref)) return { url: `data:application/octet-stream;base64,${ref.base64}` }
  const data = readFileSync(ref.localPath)
  return { url: `data:application/octet-stream;base64,${data.toString("base64")}` }
}
