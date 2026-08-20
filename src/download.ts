/**
 * Artifact downloads. Providers hand back signed CDN urls that expire; the
 * CLI pulls the bytes at packaging time so an OCI result package (or a
 * resume --output dir) stays self-contained — the layer keeps the media,
 * the config blob keeps the original url for provenance.
 */
import type { Artifact } from "./providers"

/** Downloads artifact bytes from a url; injectable for deterministic tests. */
export type ArtifactFetcher = (url: string) => Promise<Buffer>

/** Generous single-request timeout: provider videos can be hundreds of MB. */
export const ARTIFACT_DOWNLOAD_TIMEOUT_MS = 300_000

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

/** Cap the exponential backoff so a dead CDN cannot stall a build for minutes. */
const MAX_BACKOFF_MS = 5_000

function decodeDataUrl(url: string): Buffer {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url)
  const payload = m?.[3]
  if (m === null || payload === undefined || payload === "") {
    throw new Error("unsupported data: artifact url")
  }
  return m[2] === undefined
    ? Buffer.from(decodeURIComponent(payload), "utf8")
    : Buffer.from(payload, "base64")
}

type AttemptResult = { ok: true; bytes: Buffer } | { ok: false; error: Error; retryable: boolean }

async function attemptOnce(
  url: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<AttemptResult> {
  try {
    const timeout = AbortSignal.timeout(timeoutMs)
    const resp = await fetch(url, {
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    })
    if (resp.ok) {
      return { ok: true, bytes: Buffer.from(await resp.arrayBuffer()) }
    }
    return {
      ok: false,
      error: new Error(`HTTP ${resp.status} downloading ${url}`),
      retryable: RETRYABLE_STATUS.has(resp.status),
    }
  } catch (e) {
    if (signal?.aborted === true) {
      return { ok: false, error: new Error(`download aborted: ${url}`), retryable: false }
    }
    return {
      ok: false,
      error: e instanceof Error ? e : new Error(String(e)),
      retryable: true, // network hiccups and timeouts
    }
  }
}

/** Exponential backoff with jitter so parallel downloads never retry in lockstep. */
async function backoffDelay(attempt: number): Promise<void> {
  const exp = Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS)
  await new Promise((resolve) => setTimeout(resolve, exp * (0.5 + Math.random() * 0.5)))
}

/**
 * Fetch artifact bytes with bounded retries: transient 5xx/429 and network
 * hiccups get one retry pass by default; 4xx fails fast. Caller aborts win
 * over retries.
 */
export async function fetchArtifactBytes(
  url: string,
  opts: { timeoutMs?: number; retries?: number; signal?: AbortSignal } = {},
): Promise<Buffer> {
  if (url.startsWith("data:")) return decodeDataUrl(url)

  const retries = opts.retries ?? 1
  const timeoutMs = opts.timeoutMs ?? ARTIFACT_DOWNLOAD_TIMEOUT_MS
  for (let attempt = 0; ; attempt++) {
    const result = await attemptOnce(url, timeoutMs, opts.signal)
    if (result.ok) return result.bytes
    if (!result.retryable || attempt >= retries) throw result.error
    await backoffDelay(attempt)
  }
}

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
}

const KNOWN_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "mp4"])

/**
 * File extension for a staged artifact: the declared mime type wins, then a
 * known extension on the url (query strings stripped); anything else is
 * opaque binary.
 */
export function artifactExtension(artifact: {
  url?: string | undefined
  mimeType?: string | undefined
}): string {
  const byMime = artifact.mimeType === undefined ? undefined : EXT_BY_MIME[artifact.mimeType]
  if (byMime !== undefined) return byMime
  const path = artifact.url?.split("?")[0]?.split("#")[0] ?? ""
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  if (ext !== "" && KNOWN_EXTS.has(ext)) return ext === "jpeg" ? "jpg" : ext
  return "bin"
}

/** Materialize an artifact's bytes: decode base64 locally, fetch urls. */
export async function artifactBytes(
  artifact: Artifact,
  fetchBytes: ArtifactFetcher = fetchArtifactBytes,
): Promise<Buffer | undefined> {
  if (artifact.base64 !== undefined) return Buffer.from(artifact.base64, "base64")
  if (artifact.url !== undefined) return fetchBytes(artifact.url)
  return undefined
}
