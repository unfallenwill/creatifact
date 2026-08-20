/**
 * Artifact downloads. Providers hand back signed CDN urls that expire; the
 * CLI pulls the bytes at packaging time so an OCI result package (or a
 * resume --output dir) stays self-contained — the layer keeps the media,
 * the config blob keeps the original url for provenance.
 *
 * neverthrow philosophy: a download is a Result, not a thrown exception —
 * callers that degrade on failure (warn + skip) branch on isErr instead of
 * catching. p-retry philosophy: the attempt function decides *what* fails
 * (AbortError for permanent), the options decide *how often and how fast*
 * to retry (exponential backoff with jitter).
 */

import { err, errAsync, ok, okAsync, type Result, ResultAsync } from "neverthrow"
import pRetry, { AbortError } from "p-retry"
import type { Artifact } from "./providers"

/** Failure of an artifact download, with its cause for callers that care. */
export class DownloadError extends Error {
  constructor(
    message: string,
    readonly kind: "http" | "network" | "aborted" | "invalid-data-url",
    readonly status?: number,
  ) {
    super(message)
    this.name = "DownloadError"
  }
}

/** Downloads artifact bytes from a url; injectable for deterministic tests. */
export type ArtifactFetcher = (url: string) => ResultAsync<Buffer, DownloadError>

/** Generous single-request timeout: provider videos can be hundreds of MB. */
export const ARTIFACT_DOWNLOAD_TIMEOUT_MS = 300_000

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

/** Cap the exponential backoff so a dead CDN cannot stall a build for minutes. */
const MAX_BACKOFF_MS = 5_000

function decodeDataUrl(url: string): Result<Buffer, DownloadError> {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url)
  const payload = m?.[3]
  if (m === null || payload === undefined || payload === "") {
    return err(new DownloadError("unsupported data: artifact url", "invalid-data-url"))
  }
  return ok(
    m[2] === undefined
      ? Buffer.from(decodeURIComponent(payload), "utf8")
      : Buffer.from(payload, "base64"),
  )
}

/** Recover the DownloadError p-retry surfaces (it may wrap it in AbortError). */
function toDownloadError(e: unknown, url: string): DownloadError {
  if (e instanceof DownloadError) return e
  const original = (e as { originalError?: unknown } | null)?.originalError
  if (original instanceof DownloadError) return original
  // An aborted signal (interrupt or retry-policy shutdown) rejects with a
  // DOMException named AbortError.
  if (e instanceof Error && e.name === "AbortError") {
    return new DownloadError(`download aborted: ${url}`, "aborted")
  }
  return new DownloadError(e instanceof Error ? e.message : String(e), "network")
}

/**
 * Fetch artifact bytes as a Result: transient 5xx/429 and network hiccups
 * retry per the declared policy (one extra pass, 500ms→5s jittered backoff);
 * 4xx aborts the policy immediately; caller cancellation always wins.
 */
export function fetchArtifactBytes(
  url: string,
  opts: { timeoutMs?: number; retries?: number; signal?: AbortSignal } = {},
): ResultAsync<Buffer, DownloadError> {
  if (url.startsWith("data:")) {
    const decoded = decodeDataUrl(url)
    return decoded.isErr() ? errAsync(decoded.error) : okAsync(decoded.value)
  }

  return ResultAsync.fromPromise(
    pRetry(
      async () => {
        const timeout = AbortSignal.timeout(opts.timeoutMs ?? ARTIFACT_DOWNLOAD_TIMEOUT_MS)
        const resp = await fetch(url, {
          signal: opts.signal === undefined ? timeout : AbortSignal.any([opts.signal, timeout]),
        })
        if (resp.ok) return Buffer.from(await resp.arrayBuffer())
        const error = new DownloadError(
          `HTTP ${resp.status} downloading ${url}`,
          "http",
          resp.status,
        )
        if (!RETRYABLE_STATUS.has(resp.status)) throw new AbortError(error)
        throw error
      },
      {
        retries: opts.retries ?? 1,
        minTimeout: 500,
        factor: 2,
        maxTimeout: MAX_BACKOFF_MS,
        randomize: true,
        signal: opts.signal,
      },
    ),
    (e) => toDownloadError(e, url),
  )
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
export function artifactBytes(
  artifact: Artifact,
  fetchBytes: ArtifactFetcher = fetchArtifactBytes,
): ResultAsync<Buffer | undefined, DownloadError> {
  if (artifact.base64 !== undefined) return okAsync(Buffer.from(artifact.base64, "base64"))
  if (artifact.url === undefined) return okAsync(undefined)
  return fetchBytes(artifact.url)
}
