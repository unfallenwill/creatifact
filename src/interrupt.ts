/**
 * Process-wide interrupt handling, AbortSignal-first: one controller that
 * every async operation composes with its own deadline via AbortSignal.any.
 * The first SIGINT/SIGTERM aborts the signal (in-flight work unwinds,
 * finally-blocks run); the listener then detaches, so a second Ctrl-C falls
 * back to the shell's default kill — a stuck handler can never trap the
 * user. Arming is idempotent; library callers that never arm still work,
 * they just have an never-aborting signal.
 */
const controller = new AbortController()

let armed = false

export function armInterrupts(): void {
  if (armed) return
  armed = true
  const onSignal = (): void => {
    controller.abort(new Error("interrupted"))
    process.removeListener("SIGINT", onSignal)
    process.removeListener("SIGTERM", onSignal)
  }
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)
}

/** The process-wide interrupt signal; aborts on the first SIGINT/SIGTERM. */
export function interruptSignal(): AbortSignal {
  return controller.signal
}

/** The abort reason for a signal (its Error), or undefined while live. */
export function interruptReason(): Error | undefined {
  const reason: unknown = controller.signal.reason
  return reason instanceof Error ? reason : undefined
}
