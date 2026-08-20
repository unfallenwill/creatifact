import { type Result, ResultAsync } from "neverthrow"
import pRetry, { AbortError } from "p-retry"

import { type ErrorCategory, ProviderError } from "./types"

export type ClassifyError = (status: number, body: unknown) => ErrorCategory | undefined

/** Relaxed timeout for inline frame uploads and sync-style generation requests; the default 30s is tight for them. */
export const SLOW_POST_TIMEOUT_MS = 120_000

export interface RequestJsonOptions {
  method?: string
  headers?: Record<string, string>
  body?: unknown
  timeoutMs?: number
  /** Explicit retry count. Omit for the method-aware safe default. */
  retries?: number
  classifyError?: ClassifyError
  /** Caller cancellation; merged with the per-request timeout signal. */
  signal?: AbortSignal | undefined
}

export function defaultClassifyError(status: number, body: unknown): ErrorCategory {
  if (status === 401 || status === 403) return "auth"
  if (status === 429) return "rate"
  if (status === 402) return "quota"
  const text = JSON.stringify(body) ?? ""
  if (/content_policy|moderation|sensitive|审核|违规/i.test(text)) return "moderation"
  return "internal"
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

/** Never sleep longer than this between retries, even if Retry-After asks. */
const MAX_BACKOFF_MS = 30_000

/** Honor Retry-After (delta-seconds form) when present; ignore HTTP dates. */
function retryAfterMs(resp: Response): number | undefined {
  const value = resp.headers.get("retry-after")
  if (value === null) return undefined
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(seconds * 1000, MAX_BACKOFF_MS)
    : undefined
}

function snippet(text: string): string {
  return text.slice(0, 120).replace(/\s+/g, " ").trim()
}

/**
 * Safe retry defaults: idempotent GETs retry twice; non-idempotent requests
 * (POST task submissions are billable!) do not retry unless the caller
 * explicitly opts in — e.g. Kling submits carry an idempotent external id.
 */
function defaultRetries(method: string | undefined): number {
  return method === undefined || method === "GET" ? 2 : 0
}

function messageFromBody(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const err = body as Record<string, unknown>
    const msg = err["error"] ?? err["message"] ?? err["msg"]
    if (typeof msg === "string") return msg
    if (msg && typeof msg === "object") {
      const inner = (msg as Record<string, unknown>)["message"]
      if (typeof inner === "string") return inner
    }
  }
  return `HTTP ${status}`
}

type AttemptResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ProviderError; retryable: boolean; retryAfterMs?: number | undefined }

async function attemptOnce<T>(url: string, opts: RequestJsonOptions): Promise<AttemptResult<T>> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 30_000)
  const init: RequestInit = {
    method: opts.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...opts.headers,
    },
    signal: opts.signal === undefined ? timeout : AbortSignal.any([opts.signal, timeout]),
  }
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body)
  }
  try {
    const resp = await fetch(url, init)
    const text = await resp.text()

    let body: unknown
    try {
      body = text ? (JSON.parse(text) as unknown) : undefined
    } catch {
      // Non-JSON body: gateways sometimes answer with HTML error pages.
      if (resp.ok) {
        return {
          ok: false,
          error: new ProviderError(
            "internal",
            `expected JSON response but got '${snippet(text)}' (HTTP ${resp.status})`,
            text,
          ),
          retryable: false,
        }
      }
      const category =
        opts.classifyError?.(resp.status, undefined) ?? defaultClassifyError(resp.status, undefined)
      return {
        ok: false,
        error: new ProviderError(
          category,
          `HTTP ${resp.status}: ${snippet(text) || "(empty body)"}`,
          text,
          resp.status,
        ),
        retryable: RETRYABLE_STATUS.has(resp.status),
        retryAfterMs: retryAfterMs(resp),
      }
    }

    if (!resp.ok) {
      const category =
        opts.classifyError?.(resp.status, body) ?? defaultClassifyError(resp.status, body)
      const error = new ProviderError(
        category,
        messageFromBody(resp.status, body),
        body,
        resp.status,
      )
      return {
        ok: false,
        error,
        retryable: RETRYABLE_STATUS.has(resp.status),
        retryAfterMs: retryAfterMs(resp),
      }
    }
    return { ok: true, value: body as T }
  } catch (e) {
    if (e instanceof ProviderError) {
      return { ok: false, error: e, retryable: false }
    }
    return {
      ok: false,
      error: new ProviderError("internal", (e as Error).message, e),
      retryable: true,
    }
  }
}

/**
 * Fetch and decode JSON as a Result (neverthrow philosophy: provider-call
 * failures are values that flow to the CLI edge; callers interop with the
 * throwing plugin contract via _unsafeUnwrap at their boundary). Retry
 * policy is declarative (p-retry philosophy): the attempt function decides
 * *what* fails — AbortError for permanent failures — while the options own
 * pacing (exponential backoff with jitter) and budget. A server's
 * Retry-After hint is honored inside the attempt so the hint, not the
 * client's backoff, paces the next try.
 */
export function requestJson<T>(
  url: string,
  opts: RequestJsonOptions = {},
): ResultAsync<T, ProviderError> {
  return ResultAsync.fromPromise(
    pRetry(
      async () => {
        const result = await attemptOnce<T>(url, opts)
        if (result.ok) return result.value
        if (!result.retryable) throw new AbortError(result.error)
        if (result.retryAfterMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, result.retryAfterMs))
        }
        throw result.error
      },
      {
        retries: opts.retries ?? defaultRetries(opts.method),
        minTimeout: 500,
        factor: 2,
        maxTimeout: MAX_BACKOFF_MS,
        randomize: true,
        signal: opts.signal,
      },
    ),
    recoverProviderError,
  )
}

/** Map whatever p-retry surfaces back to a ProviderError. */
function recoverProviderError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e
  const original = (e as { originalError?: unknown } | null)?.originalError
  if (original instanceof ProviderError) return original
  if (e instanceof Error && e.name === "AbortError") {
    return new ProviderError("internal", "request aborted", e)
  }
  return new ProviderError("internal", e instanceof Error ? e.message : String(e), e)
}

/**
 * Throwing edge for the plugin contract: provider functions expose
 * Promise<T> + throw semantics to generate.ts and third-party plugin
 * callers, so this is the single sanctioned unwrap point — Result values
 * live between here and the CLI envelope.
 */
export function unwrapOrThrow<T>(result: Result<T, ProviderError>): T {
  if (result.isErr()) throw result.error
  return result.value
}

export interface JsonClientConfig {
  baseUrl: string
  /** Static headers, or a function for per-request credentials (e.g. signed JWT). */
  headers?: Record<string, string> | (() => Record<string, string>)
  classifyError?: ClassifyError
  /** Default retry count for every call (overrides the method-aware default). */
  retries?: number
  /** Default per-request timeout for every call (overrides the 30s default). */
  timeoutMs?: number
}

export interface JsonClient {
  get<T>(path: string, opts?: Omit<RequestJsonOptions, "method">): ResultAsync<T, ProviderError>
  post<T>(
    path: string,
    body?: unknown,
    opts?: Omit<RequestJsonOptions, "method" | "body">,
  ): ResultAsync<T, ProviderError>
  del<T>(path: string, opts?: Omit<RequestJsonOptions, "method">): ResultAsync<T, ProviderError>
}

/**
 * Shared HTTP client factory so each provider stops hand-rolling the same
 * baseUrl/headers/classifyError merge. One instance per provider.
 */
export function createJsonClient(config: JsonClientConfig): JsonClient {
  const baseHeaders = config.headers ?? {}
  const merge = (opts: RequestJsonOptions | undefined): RequestJsonOptions => {
    const merged: RequestJsonOptions = {
      ...opts,
      headers: {
        ...(typeof baseHeaders === "function" ? baseHeaders() : baseHeaders),
        ...opts?.headers,
      },
    }
    const classify = opts?.classifyError ?? config.classifyError
    if (classify !== undefined) merged.classifyError = classify
    const retries = opts?.retries ?? config.retries
    if (retries !== undefined) merged.retries = retries
    const timeoutMs = opts?.timeoutMs ?? config.timeoutMs
    if (timeoutMs !== undefined) merged.timeoutMs = timeoutMs
    return merged
  }

  return {
    get<T>(path: string, opts?: Omit<RequestJsonOptions, "method">): ResultAsync<T, ProviderError> {
      return requestJson<T>(`${config.baseUrl}${path}`, merge(opts))
    },
    post<T>(
      path: string,
      body?: unknown,
      opts?: Omit<RequestJsonOptions, "method" | "body">,
    ): ResultAsync<T, ProviderError> {
      return requestJson<T>(`${config.baseUrl}${path}`, merge({ ...opts, body, method: "POST" }))
    },
    del<T>(path: string, opts?: Omit<RequestJsonOptions, "method">): ResultAsync<T, ProviderError> {
      return requestJson<T>(`${config.baseUrl}${path}`, merge({ ...opts, method: "DELETE" }))
    },
  }
}
