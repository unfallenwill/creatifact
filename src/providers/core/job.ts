import type { JobHandle, JobStatus } from "./types"

export interface PollOptions {
  intervalMs: number
  timeoutMs: number
  backoffFactor?: number
  maxIntervalMs?: number
  signal?: AbortSignal
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

    if (opts.signal?.aborted) throw new Error("polling aborted")
    if (Date.now() >= deadline) throw new JobTimeoutError(handle.id)

    const status = await poll(handle)
    opts.onStatus?.(status)

    if (status.state === "done" || status.state === "failed") {
      return status
    }
  }
}
