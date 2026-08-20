/**
 * The unified output envelope. stdout carries exactly one JSON document per
 * successful command; failures print the same envelope shape (with `error`)
 * to stderr and exit with a code from EXIT_CODES. `--pretty` switches stdout
 * to indented JSON, colorized when stdout is a TTY.
 */
import { CommanderError } from "commander"
import { ConfigError } from "./config"
import { CliError, type ErrorCode, EXIT_CODES } from "./errors"
import { pc } from "./format"
import { JobTimeoutError, ProviderError } from "./providers"

/** Command kinds that can appear in an envelope's `kind` field. */
export type EnvelopeKind =
  | "build"
  | "push"
  | "pull"
  | "generate"
  | "login"
  | "logout"
  | "models"
  | "config"
  | "package.list"
  | "package.rm"
  | "package.tag"
  | "pipeline"

export interface OutputOptions {
  pretty?: boolean | undefined
}

export interface ErrorEnvelopePayload {
  code: ErrorCode
  message: string
  details?: Record<string, unknown> | undefined
}

const NETWORK_ERRNOS = new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
])

/**
 * Normalize any thrown value into the envelope's error payload. Known error
 * classes keep their classification; Node fs errors (ENOENT, EACCES, ...)
 * and fetch failures are recognized structurally; anything else is an
 * internal error so genuine bugs stay loud.
 */
export function classifyError(e: unknown): ErrorEnvelopePayload {
  if (e instanceof CliError) {
    return e.details === undefined
      ? { code: e.code, message: e.message }
      : { code: e.code, message: e.message, details: e.details }
  }
  if (e instanceof ConfigError) {
    return { code: "E_CONFIG", message: e.message }
  }
  if (e instanceof ProviderError) {
    const details: Record<string, unknown> = { category: e.category }
    if (e.status !== undefined) details["status"] = e.status
    return { code: "E_PROVIDER", message: e.message, details }
  }
  if (e instanceof JobTimeoutError) {
    return { code: "E_TIMEOUT", message: e.message }
  }
  if (e instanceof CommanderError) {
    return { code: "E_USAGE", message: e.message }
  }
  const err = e as { message?: unknown; code?: unknown; cause?: { code?: unknown } }
  const message = e instanceof Error ? e.message : String(e)
  return classifyUnclassified(err, message)
}

/** Classify errors that carry no domain class: network, fs, or internal. */
function classifyUnclassified(
  err: { code?: unknown; cause?: { code?: unknown } },
  message: string,
): ErrorEnvelopePayload {
  // fetch() failures surface as TypeError("fetch failed") with the socket
  // errno on `cause`; some stacks rethrow with the errno on the error itself.
  const errno = typeof err.cause?.code === "string" ? err.cause.code : undefined
  if (message.includes("fetch failed") || (errno !== undefined && NETWORK_ERRNOS.has(errno))) {
    return errno === undefined
      ? { code: "E_NETWORK", message }
      : { code: "E_NETWORK", message, details: { errno } }
  }
  // Node fs/system errors carry an errno-style `code` (ENOENT, EACCES, ...).
  if (typeof err.code === "string" && /^E[A-Z]+$/.test(err.code)) {
    return { code: "E_IO", message, details: { errno: err.code } }
  }
  return { code: "E_INTERNAL", message }
}

/** The success envelope document: stable key order, `data` last. */
export function formatResultEnvelope(
  kind: EnvelopeKind,
  data: unknown,
  opts: OutputOptions = {},
): string {
  const doc = { ok: true as const, kind, data }
  return opts.pretty === true ? colorizeJson(JSON.stringify(doc, null, 2)) : JSON.stringify(doc)
}

/** The failure envelope document; `details` is included when present. */
export function formatErrorEnvelope(
  kind: EnvelopeKind | undefined,
  payload: ErrorEnvelopePayload,
  opts: OutputOptions = {},
): string {
  const error =
    payload.details === undefined
      ? { code: payload.code, message: payload.message }
      : { code: payload.code, message: payload.message, details: payload.details }
  const doc =
    kind === undefined ? { ok: false as const, error } : { ok: false as const, kind, error }
  return opts.pretty === true ? colorizeJson(JSON.stringify(doc, null, 2)) : JSON.stringify(doc)
}

/** Print the success envelope to stdout (the only stdout write a command makes). */
export function emitResult(kind: EnvelopeKind, data: unknown, opts: OutputOptions = {}): void {
  process.stdout.write(`${formatResultEnvelope(kind, data, opts)}\n`)
}

/**
 * Print the failure envelope to stderr and return the process exit code.
 * stdout stays untouched so partial pipelines never see mixed output.
 */
export function emitError(
  kind: EnvelopeKind | undefined,
  e: unknown,
  opts: OutputOptions = {},
): number {
  const payload = classifyError(e)
  process.stderr.write(`${formatErrorEnvelope(kind, payload, opts)}\n`)
  return EXIT_CODES[payload.code]
}

/**
 * Single-pass pretty-JSON colorizer: string keys cyan, string values green,
 * booleans magenta, null dim, numbers yellow. The alternation matches each
 * token exactly once, so ANSI escapes injected for earlier tokens are never
 * rescanned by later patterns. No-op when color is disabled (`pc` is
 * TTY-gated), keeping piped `--pretty` output byte-identical plain JSON.
 */
function colorizeJson(text: string): string {
  return text.replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\bnull\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (
      _match,
      str: string,
      colon: string | undefined,
      bool: string | undefined,
      num: string | undefined,
    ) => {
      if (str !== undefined) return colon !== undefined ? `${pc.cyan(str)}${colon}` : pc.green(str)
      if (bool !== undefined) return pc.magenta(bool)
      if (num !== undefined) return pc.yellow(num)
      return pc.dim("null")
    },
  )
}
