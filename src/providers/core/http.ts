import { type ErrorCategory, ProviderError } from "./types"

export type ClassifyError = (status: number, body: unknown) => ErrorCategory | undefined

export interface RequestJsonOptions {
  method?: string
  headers?: Record<string, string>
  body?: unknown
  timeoutMs?: number
  /** Explicit retry count. Omit for the method-aware safe default. */
  retries?: number
  classifyError?: ClassifyError
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
  const init: RequestInit = {
    method: opts.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...opts.headers,
    },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
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

export async function requestJson<T>(url: string, opts: RequestJsonOptions = {}): Promise<T> {
  const retries = opts.retries ?? defaultRetries(opts.method)
  let lastError: ProviderError | undefined
  let lastRetryAfterMs: number | undefined

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff with jitter (50-100%) so concurrent clients
      // hammered by the same 429 don't retry in lockstep.
      const exp = Math.min(500 * 2 ** (attempt - 1), MAX_BACKOFF_MS)
      const delay = lastRetryAfterMs ?? exp * (0.5 + Math.random() * 0.5)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
    const result = await attemptOnce<T>(url, opts)
    if (result.ok) {
      return result.value
    }
    lastError = result.error
    lastRetryAfterMs = result.retryAfterMs
    if (!result.retryable || attempt === retries) {
      throw result.error
    }
  }

  throw lastError ?? new ProviderError("internal", "request failed")
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
  get<T>(path: string, opts?: Omit<RequestJsonOptions, "method">): Promise<T>
  post<T>(
    path: string,
    body?: unknown,
    opts?: Omit<RequestJsonOptions, "method" | "body">,
  ): Promise<T>
  del<T>(path: string, opts?: Omit<RequestJsonOptions, "method">): Promise<T>
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
    get<T>(path: string, opts?: Omit<RequestJsonOptions, "method">): Promise<T> {
      return requestJson<T>(`${config.baseUrl}${path}`, merge(opts))
    },
    post<T>(
      path: string,
      body?: unknown,
      opts?: Omit<RequestJsonOptions, "method" | "body">,
    ): Promise<T> {
      return requestJson<T>(`${config.baseUrl}${path}`, merge({ ...opts, body, method: "POST" }))
    },
    del<T>(path: string, opts?: Omit<RequestJsonOptions, "method">): Promise<T> {
      return requestJson<T>(`${config.baseUrl}${path}`, merge({ ...opts, method: "DELETE" }))
    },
  }
}
