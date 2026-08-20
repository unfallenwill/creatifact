import OpenAI, { APIError } from "openai"

import { type ClassifyError, defaultClassifyError } from "./http"
import { ProviderError } from "./types"

/** Matches the JSON client's 30s default; the SDK would otherwise wait 10 minutes. */
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * The SDK resolves `globalThis.fetch` once at construction; tests (and hot
 * reloads) swap the binding afterwards, so always resolve it per call.
 */
const lazyFetch: typeof fetch = (url, init) => globalThis.fetch(url, init)

export interface OpenAiClientConfig {
  apiKey: string
  baseUrl: string
}

/**
 * Client for an OpenAI-compatible surface (chat/completions, embeddings,
 * images/generations). Billable POSTs must not silently retry — the JSON
 * client's no-POST-retry policy carries over as maxRetries: 0.
 */
export function createOpenAiClient(config: OpenAiClientConfig): OpenAI {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    maxRetries: 0,
    timeout: DEFAULT_TIMEOUT_MS,
    fetch: lazyFetch,
  })
}

/** Message parity with core/http's messageFromBody: the body's error.message wins over the SDK's "401 …" prefix. */
function messageFromApiError(e: APIError): string {
  if (e.error && typeof e.error === "object") {
    const msg = (e.error as Record<string, unknown>)["message"]
    if (typeof msg === "string" && msg !== "") return msg
  }
  return e.message
}

/** Convert whatever the SDK throws into the CLI's ProviderError envelope, keeping each provider's classification. */
export function toProviderError(
  e: unknown,
  classifyError: ClassifyError | undefined,
): ProviderError {
  if (e instanceof ProviderError) return e
  if (e instanceof OpenAI.APIUserAbortError) {
    return new ProviderError("internal", "request aborted", e)
  }
  if (e instanceof APIError) {
    const category = classifyError?.(e.status, e.error) ?? defaultClassifyError(e.status, e.error)
    return new ProviderError(category, messageFromApiError(e), e.error, e.status)
  }
  return new ProviderError("internal", e instanceof Error ? e.message : String(e), e)
}

/** Run one SDK call with the throwing-plugin contract (errors become classified ProviderErrors). */
export async function callOpenAi<T>(
  fn: () => Promise<T>,
  classifyError: ClassifyError | undefined,
): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    throw toProviderError(e, classifyError)
  }
}

/**
 * Sanctioned boundary cast into the SDK's typed request params: provider
 * option objects are passthrough by contract and carry vendor keys the SDK
 * types don't know about (`[key: string]: unknown`), so they can never be
 * structurally assignable — the values ride along verbatim.
 */
export function sdkParams<T>(body: Record<string, unknown>): T {
  return body as unknown as T
}
