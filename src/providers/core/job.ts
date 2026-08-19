import { type Artifact, type JobHandle, type JobStatus, ProviderError } from "./types"

export interface PollOptions {
  intervalMs: number
  timeoutMs: number
  backoffFactor?: number
  maxIntervalMs?: number
  signal?: AbortSignal | undefined
  onStatus?: (status: JobStatus) => void
}

export class JobTimeoutError extends Error {
  constructor(id: string) {
    super(`job '${id}' timed out while polling`)
    this.name = "JobTimeoutError"
  }
}

export async function pollUntil(
  poll: (handle: JobHandle) => Promise<JobStatus>,
  handle: JobHandle,
  opts: PollOptions,
): Promise<Extract<JobStatus, { state: "done" | "failed" }>> {
  const backoff = opts.backoffFactor ?? 1
  const maxInterval = opts.maxIntervalMs ?? opts.intervalMs
  const deadline = Date.now() + opts.timeoutMs
  let interval = opts.intervalMs
  let first = true

  for (;;) {
    if (!first) {
      await new Promise((resolve) => setTimeout(resolve, interval))
      interval = Math.min(interval * backoff, maxInterval)
    }
    first = false

    if (opts.signal?.aborted) throw new Error(`polling aborted (task '${handle.id}')`)
    if (Date.now() >= deadline) throw new JobTimeoutError(handle.id)

    const status = await poll(handle)
    opts.onStatus?.(status)

    if (status.state === "done" || status.state === "failed") {
      return status
    }
  }
}

/**
 * Poll until done/failed and settle into an artifacts result. JobTimeoutError
 * becomes a ProviderError whose raw carries the task id (callers can resume
 * via the provider's poll endpoint); a failed status rethrows as a
 * ProviderError with the provider's error category.
 */
export async function pollToArtifacts(
  poll: (handle: JobHandle) => Promise<JobStatus>,
  handle: JobHandle,
  opts: PollOptions & { label: string },
): Promise<{ artifacts: Artifact[] }> {
  let final: Extract<JobStatus, { state: "done" | "failed" }>
  try {
    final = await pollUntil(poll, handle, opts)
  } catch (e) {
    if (e instanceof JobTimeoutError) {
      throw new ProviderError("internal", `${opts.label} timed out (task ${handle.id})`, {
        taskId: handle.id,
      })
    }
    throw e
  }
  if (final.state === "done") return { artifacts: final.artifacts }
  throw new ProviderError(
    final.error.category,
    `${opts.label} failed (task ${handle.id})`,
    final.error.raw,
  )
}
