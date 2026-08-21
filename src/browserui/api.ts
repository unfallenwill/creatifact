/** Typed client for the store browser API served by src/browse.ts. */

export interface RunMeta {
  task: string
  provider?: string
  model?: string
  createdAt?: string
}

export interface Entry {
  ref: string
  digest: string
  size: number
  kind: "run" | "image"
  annotations: Record<string, string>
  run?: RunMeta
  cover?: string
}

export interface FileEntry {
  path: string
  type: "file" | "dir" | "symlink"
  size?: number
  target?: string
}

export interface Detail {
  ref: string
  digest: string
  size: number
  kind: "run" | "image"
  annotations: Record<string, string>
  run?: Record<string, unknown>
  result?: Record<string, unknown>
  files: FileEntry[]
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `${res.status} ${res.statusText}`)
  }
  return (await res.json()) as T
}

export function listPackages(): Promise<Entry[]> {
  return json<Entry[]>("/api/packages")
}

export function getPackage(ref: string): Promise<Detail> {
  return json<Detail>(`/api/packages/${encodeURIComponent(ref)}`)
}

export function deletePackage(
  ref: string,
): Promise<{ untagged: string[]; deletedBlobs: string[] }> {
  return json(`/api/packages/${encodeURIComponent(ref)}`, { method: "DELETE" })
}

export function fileUrl(ref: string, path: string): string {
  return `/package/${encodeURIComponent(ref)}/file/${encodeURIComponent(path)}`
}

/** "1.4 MiB"-style formatting shared by the card and detail views. */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KiB", "MiB", "GiB"]
  let value = bytes
  let unit = -1
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const label = units[unit] ?? "KiB"
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${label}`
}

const MEDIA_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "avif",
  "svg",
  "mp4",
  "webm",
  "mov",
  "mp3",
  "wav",
  "ogg",
  "m4a",
  "flac",
])

export function ext(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? ""
}

export function isMedia(path: string): boolean {
  return MEDIA_EXT.has(ext(path))
}

export function isImage(path: string): boolean {
  return ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg"].includes(ext(path))
}

export function isVideo(path: string): boolean {
  return ["mp4", "webm", "mov"].includes(ext(path))
}

export function isText(path: string): boolean {
  return ["txt", "md", "json", "csv", "log"].includes(ext(path))
}

/** Field pickers for the loosely-typed run/result records. */
export function str(rec: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = rec?.[key]
  return typeof value === "string" ? value : undefined
}

export function strArray(
  rec: Record<string, unknown> | undefined,
  key: string,
): string[] | undefined {
  const value = rec?.[key]
  return Array.isArray(value) && value.every((v) => typeof v === "string")
    ? (value as string[])
    : undefined
}

export interface Artifact {
  name?: string
  url?: string
  mimeType?: string
}

export function artifacts(result: Record<string, unknown> | undefined): Artifact[] {
  const value = result?.["artifacts"]
  return Array.isArray(value) ? (value as Artifact[]) : []
}
