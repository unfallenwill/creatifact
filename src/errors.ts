/**
 * Structured error taxonomy for the CLI boundary. Every failing command
 * normalizes to a CliError (or is classified in output.ts) so the exit path
 * can emit a machine-readable error envelope with a stable code and exit
 * status instead of ad-hoc text.
 */

export type ErrorCode =
  | "E_USAGE"
  | "E_CONFIG"
  | "E_AUTH"
  | "E_NETWORK"
  | "E_PROVIDER"
  | "E_IO"
  | "E_TIMEOUT"
  | "E_INTERNAL"

/** Distinct process exit status per error code (0 is reserved for success). */
export const EXIT_CODES: Record<ErrorCode, number> = {
  E_USAGE: 2,
  E_CONFIG: 3,
  E_AUTH: 4,
  E_NETWORK: 5,
  E_PROVIDER: 6,
  E_IO: 7,
  E_TIMEOUT: 8,
  E_INTERNAL: 1,
}

/**
 * An error carrying its machine-readable classification. `details` is
 * optional structured context (e.g. provider category, task handle) that the
 * error envelope passes through verbatim.
 */
export class CliError extends Error {
  readonly code: ErrorCode
  readonly details: Record<string, unknown> | undefined

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = "CliError"
    this.code = code
    this.details = details
  }
}

/** Convenience factories for the most common classifications. */
export const usageError = (message: string): CliError => new CliError("E_USAGE", message)
export const configError = (message: string): CliError => new CliError("E_CONFIG", message)
export const authError = (message: string): CliError => new CliError("E_AUTH", message)
