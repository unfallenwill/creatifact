import { readFileSync } from "node:fs"
import { printArtifacts } from "./gen"
import {
  createProvider,
  type JobHandle,
  JobTimeoutError,
  ProviderError,
  pollUntil,
} from "./providers"
import { parseCliArgs, parseDurationMs, readPasswordFromStdin } from "./util"

export const JOBS_USAGE = `Usage: openmmcli jobs <handle|file> [options]

Resume polling a video generation task saved by \`gen --no-wait\`.

Arguments:
  <handle|file>         The task handle: inline JSON (starts with "{") or a
                        path to a file containing it. When omitted, reads the
                        handle from stdin.

Options:
      --timeout <dur>   Polling timeout (default 10m; e.g. 90s, 5m, 600)
      --interval <dur>  Polling interval (default 5s)
      --json            Print structured JSON to stdout
  -h, --help            Show this help message`

const VALUE_OPTS: Record<string, string> = {
  "--timeout": "timeout",
  "--interval": "interval",
}
const BOOL_FLAGS: Record<string, string> = { "--json": "json" }

export interface ParsedJobsArgs {
  source: string | undefined
  json: boolean
  timeoutMs: number | undefined
  intervalMs: number | undefined
}

export function parseJobsArgs(args: string[]): ParsedJobsArgs {
  const parsed = parseCliArgs(args, { values: VALUE_OPTS, flags: BOOL_FLAGS })
  const timeout = parsed.values["timeout"]
  const interval = parsed.values["interval"]
  return {
    source: parsed.positionals[0],
    json: parsed.flags["json"] === true,
    timeoutMs: typeof timeout === "string" ? parseDurationMs(timeout, "--timeout") : undefined,
    intervalMs: typeof interval === "string" ? parseDurationMs(interval, "--interval") : undefined,
  }
}

export function parseHandle(raw: string): JobHandle {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error("handle is not valid JSON")
  }
  const handle = value as Partial<JobHandle>
  if (typeof handle.providerId !== "string" || handle.providerId === "") {
    throw new Error("handle JSON must have a non-empty string 'providerId'")
  }
  if (typeof handle.id !== "string" || handle.id === "") {
    throw new Error("handle JSON must have a non-empty string 'id'")
  }
  return handle as JobHandle
}

export async function runJobsFromArgs(
  args: string[],
  opts: { configPath?: string } = {},
): Promise<void> {
  const p = parseJobsArgs(args)

  let raw: string | undefined
  if (p.source !== undefined) {
    raw = p.source.startsWith("{") ? p.source : readFileSync(p.source, "utf8")
  } else if (!process.stdin.isTTY) {
    raw = await readPasswordFromStdin()
  }
  if (raw === undefined) {
    throw new Error("expected a handle (inline JSON, file path, or stdin)")
  }
  const handle = parseHandle(raw.trim())

  const provider = await createProvider(handle.providerId, opts)
  const videoApi = provider.videoGenerate
  if (videoApi === undefined) {
    throw new Error(`provider '${handle.providerId}' implements no video generation`)
  }

  const controller = new AbortController()
  const onSignal = () => controller.abort()
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)

  const startedAt = Date.now()
  const final = await pollUntil((h) => videoApi.poll(h), handle, {
    intervalMs: p.intervalMs ?? 5000,
    timeoutMs: p.timeoutMs ?? 600_000,
    signal: controller.signal,
    onStatus: (s) =>
      console.error(
        `polling... ${s.state}${s.state === "running" && s.progress !== undefined ? ` ${s.progress}%` : ""} (${Math.round((Date.now() - startedAt) / 1000)}s)`,
      ),
  }).catch((e: unknown) => {
    if (controller.signal.aborted || e instanceof JobTimeoutError) {
      throw new Error(`${(e as Error).message}; task handle: ${JSON.stringify(handle)}`)
    }
    throw e
  })

  if (final.state === "failed") {
    throw new ProviderError(
      final.error.category,
      `generation failed (task ${handle.id})`,
      final.error.raw,
    )
  }
  if (p.json) {
    console.log(
      JSON.stringify(
        { provider: provider.id, artifacts: final.artifacts, usage: final.usage },
        null,
        2,
      ),
    )
  } else {
    printArtifacts(final.artifacts, {})
  }
}
