import { ProviderError, type VerifiedModel, type VideoGenerateRequest } from "./types"

/**
 * Pre-validate frame inputs against verified model metadata, so unsupported
 * combinations fail fast with an `invalid` error instead of surfacing later
 * as a provider-side failure.
 *
 * Metadata semantics (`ModelSupport`):
 * - `true`  — verified supported (no opinion here; provider logic handles it)
 * - `false` — verified NOT supported → rejected here
 * - omitted — unverified → passes through; the provider's own mode logic or
 *   the remote API stays the authority. This keeps half-verified catalogs
 *   from silently rejecting requests that actually work.
 *
 * Unknown model ids also pass through for the same reason.
 */
export function guardFrameSupport(
  models: VerifiedModel[],
  req: VideoGenerateRequest<unknown>,
): void {
  const support = models.find((m) => m.id === req.model)?.capabilities["video.generate"]
  if (!support) return
  if (req.firstFrame && support.firstFrame === false) {
    throw new ProviderError("invalid", `model '${req.model}' does not support a first frame`)
  }
  if (req.lastFrame && support.lastFrame === false) {
    throw new ProviderError("invalid", `model '${req.model}' does not support a last frame`)
  }
}
