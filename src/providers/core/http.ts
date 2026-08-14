import { type ErrorCategory, ProviderError } from "./types"

export interface RequestJsonOptions {
  method?: string
  headers?: Record<string, string>
  body?: unknown
  timeoutMs?: number
  retries?: number
  classifyError?: (status: number, body: unknown) => ErrorCategory | undefined
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

export function defaultClassifyError(status: number, body: unknown): ErrorCategory {
  if (status === 401 || status === 403) return "auth"
  if (status === 429) return "rate"
  if (status === 402) return "quota"
  const text = JSON.stringify(body) ?? ""
  if (/content_policy|moderation|sensitive|审核|违规/i.test(text)) return "moderation"
  return "internal"
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
  | { ok: false; error: ProviderError; retryable: boolean }

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
    const body = text ? (JSON.parse(text) as unknown) : undefined

    if (!resp.ok) {
      const category =
        opts.classifyError?.(resp.status, body) ?? defaultClassifyError(resp.status, body)
      const error = new ProviderError(
        category,
        messageFromBody(resp.status, body),
        body,
        resp.status,
      )
      return { ok: false, error, retryable: RETRYABLE_STATUS.has(resp.status) }
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
  const retries = opts.retries ?? 2
  let lastError: ProviderError | undefined

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)))
    }
    const result = await attemptOnce<T>(url, opts)
    if (result.ok) {
      return result.value
    }
    lastError = result.error
    if (!result.retryable || attempt === retries) {
      throw result.error
    }
  }

  throw lastError ?? new ProviderError("internal", "request failed")
}
