import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import {
  type Artifact,
  type Capability,
  capabilitiesOf,
  createProvider,
  type FileRef,
  JobTimeoutError,
  type Provider,
  ProviderError,
  pollUntil,
  type Usage,
} from "./providers"
import { parseCliArgs, parseDurationMs, parseKvValue } from "./util"

export const GEN_USAGE = `Usage: openmmcli gen <provider>/<model> [options]

Generate media via a provider model. The lane (image/video generation,
understanding, embedding) is derived from the model's capabilities and the
input flags: --prompt drives generation, --ask drives understanding,
--input drives embeddings / message attachments.

Progress and notes go to stderr; results go to stdout.

Arguments:
  <provider>/<model>   e.g. zhipu/cogview-3-flash, ark/doubao-seedance-2.0
                       (run \`openmmcli models\` for verified ids)

Options:
  --prompt <text>       Generation instruction (required for generate lanes)
  --ask <text>          Question for understanding models (mutually exclusive
                        with --prompt)
  --input <text|path|url>  Repeatable. Embedding inputs, or attachments for
                        --ask (http(s)/data URL or existing path = file,
                        otherwise plain text)
      --first-frame <path|url>  Video first frame / reference image
      --last-frame <path|url>   Video last frame
      --image <path|url>        Reference image for image generation
      --opt <k=v>        Repeatable provider-specific option; the value is
                        parsed as JSON when valid (5 → 5, true → true), else
                        kept as a string (1920x1080). Force a string with
                        --opt 'k="v"'
      --no-wait         Video only: submit and print the task handle as one
                        line of JSON, then exit (resume with \`openmmcli jobs\`)
      --timeout <dur>   Polling timeout (default 10m; e.g. 90s, 5m, 600)
      --interval <dur>  Polling interval (default 5s)
      --output <dir>    Directory to save base64-only artifacts
      --json            Print structured JSON to stdout
  -h, --help            Show this help message

Examples:
  openmmcli gen zhipu/cogview-3-flash --prompt "a crane" --opt size=1024x1024
  openmmcli gen zhipu/cogvideox-flash --prompt "a paper crane" --no-wait
  openmmcli gen ark/doubao-1.5-vision-pro --image ./cat.png --ask "what is this"
  openmmcli gen ark/doubao-embedding-large-text-240915 --input "hello" --input ./note.txt`

const VALUE_OPTS: Record<string, string> = {
  "--prompt": "prompt",
  "--ask": "ask",
  "--input": "input",
  "--first-frame": "firstFrame",
  "--last-frame": "lastFrame",
  "--image": "image",
  "--opt": "opt",
  "--timeout": "timeout",
  "--interval": "interval",
  "--output": "output",
}
const BOOL_FLAGS: Record<string, string> = { "--no-wait": "noWait", "--json": "json" }
const REPEATS = new Set(["--input", "--opt"])

export interface ParsedGenArgs {
  target: string | undefined
  prompt: string | undefined
  ask: string | undefined
  inputs: string[]
  firstFrame: string | undefined
  lastFrame: string | undefined
  image: string | undefined
  opts: Record<string, unknown>
  noWait: boolean
  json: boolean
  timeoutMs: number | undefined
  intervalMs: number | undefined
  outputDir: string | undefined
}

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined
}

function many(value: string | string[] | undefined): string[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value]
}

function parseOptRepeats(raw: string | string[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const item of many(raw)) {
    const eq = item.indexOf("=")
    const key = eq === -1 ? "" : item.slice(0, eq)
    if (eq === -1 || key === "") {
      throw new Error(`invalid --opt '${item}' (expected k=v)`)
    }
    out[key] = parseKvValue(item.slice(eq + 1))
  }
  return out
}

export function parseGenArgs(args: string[]): ParsedGenArgs {
  const parsed = parseCliArgs(args, { values: VALUE_OPTS, flags: BOOL_FLAGS, repeats: REPEATS })
  const timeout = single(parsed.values["timeout"])
  const interval = single(parsed.values["interval"])
  return {
    target: parsed.positionals[0],
    prompt: single(parsed.values["prompt"]),
    ask: single(parsed.values["ask"]),
    inputs: many(parsed.values["input"]),
    firstFrame: single(parsed.values["firstFrame"]),
    lastFrame: single(parsed.values["lastFrame"]),
    image: single(parsed.values["image"]),
    opts: parseOptRepeats(parsed.values["opt"]),
    noWait: parsed.flags["noWait"] === true,
    json: parsed.flags["json"] === true,
    timeoutMs: timeout === undefined ? undefined : parseDurationMs(timeout, "--timeout"),
    intervalMs: interval === undefined ? undefined : parseDurationMs(interval, "--interval"),
    outputDir: single(parsed.values["output"]),
  }
}

const URL_RE = /^(https?:|data:)/

export function toFileRef(value: string, flag: string): FileRef {
  if (URL_RE.test(value)) return { url: value }
  if (!existsSync(value)) {
    throw new Error(`${flag} file not found: ${value} (or pass an http(s)/data URL)`)
  }
  return { localPath: value }
}

function toContentPart(value: string): string | { file: FileRef; text?: string } {
  if (URL_RE.test(value)) return { file: { url: value } }
  if (existsSync(value)) return { file: { localPath: value } }
  return value
}

function isGenerate(c: Capability): boolean {
  return c === "image.generate" || c === "video.generate"
}

function isUnderstand(c: Capability): boolean {
  return c === "image.understand" || c === "video.understand"
}

/** Pick the lane from the model's declared capabilities ∩ the provider's APIs, resolved by trigger flags. */
export function resolveLane(
  provider: { models: { id: string; capabilities: Partial<Record<Capability, unknown>> }[] },
  model: string,
  triggers: { prompt: boolean; ask: boolean; inputs: number },
): Capability {
  const available = new Set(capabilitiesOf(provider as Parameters<typeof capabilitiesOf>[0]))
  const declared = provider.models.find((m) => m.id === model)?.capabilities
  const candidates = declared
    ? (Object.keys(declared) as Capability[]).filter((c) => available.has(c))
    : [...available]
  if (candidates.length === 0) {
    throw new Error(`model '${model}' declares no capability this provider implements`)
  }

  const pick = pickFromCandidates(candidates, triggers)
  if (pick !== undefined) return pick
  throw new Error(
    `model '${model}' supports multiple lanes (${candidates.join(", ")}); ` +
      "disambiguate with --prompt (generate), --ask (understand), or --input",
  )
}

function pickFromCandidates(
  candidates: Capability[],
  triggers: { prompt: boolean; ask: boolean; inputs: number },
): Capability | undefined {
  const single = candidates.length === 1 ? candidates[0] : undefined
  // Understand/embed lanes need their trigger (--ask / --input); without one
  // they are not silent defaults, even when they are the only candidate.
  if (single !== undefined && !isUnderstand(single) && single !== "embed") return single

  if (triggers.prompt) {
    const generate = candidates.filter(isGenerate)
    if (generate.length === 1) return generate[0]
  }
  if (triggers.ask || triggers.inputs > 0) {
    // The image/video understand pair shares one chat endpoint (Ark vision models).
    const understood = candidates.filter(isUnderstand)
    if (understood.length > 0) {
      return understood.includes("image.understand") ? "image.understand" : "video.understand"
    }
    if (candidates.includes("embed")) return "embed"
  }
  return undefined
}

function describeStatus(status: { state: string; progress?: number | undefined }): string {
  return status.progress === undefined ? status.state : `${status.state} ${status.progress}%`
}

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
}

export function printArtifacts(
  artifacts: Artifact[],
  opts: { outputDir?: string | undefined },
): void {
  artifacts.forEach((a, i) => {
    if (a.url !== undefined) {
      console.log(a.url)
      return
    }
    if (a.base64 === undefined) return
    if (opts.outputDir === undefined) {
      console.error(
        `artifact ${i + 1}: base64 ${a.mimeType ?? "unknown"} (pass --output <dir> to save)`,
      )
      return
    }
    mkdirSync(opts.outputDir, { recursive: true })
    const ext = (a.mimeType && MIME_EXT[a.mimeType]) || "bin"
    const file = `${opts.outputDir}/artifact-${i + 1}.${ext}`
    writeFileSync(file, Buffer.from(a.base64, "base64"))
    console.log(file)
  })
}

export interface GenRunOptions {
  configPath?: string
}

interface LaneContext {
  p: ParsedGenArgs
  model: string
  signal: AbortSignal
}

async function runVideoLane(provider: Provider, ctx: LaneContext): Promise<void> {
  const { p, model, signal } = ctx
  const videoApi = provider.videoGenerate
  if (p.prompt === undefined) throw new Error("--prompt is required for video generation")
  if (p.image !== undefined) throw new Error("--image only applies to image generation")
  if (videoApi === undefined) throw new Error("provider implements no video generation")
  const req = {
    model,
    prompt: p.prompt,
    options: p.opts,
    ...(p.firstFrame !== undefined ? { firstFrame: toFileRef(p.firstFrame, "--first-frame") } : {}),
    ...(p.lastFrame !== undefined ? { lastFrame: toFileRef(p.lastFrame, "--last-frame") } : {}),
  }
  const handle = await videoApi.submit(req)
  if (p.noWait) {
    console.log(JSON.stringify(handle))
    return
  }
  const startedAt = Date.now()
  const final = await pollUntil((h) => videoApi.poll(h), handle, {
    intervalMs: p.intervalMs ?? 5000,
    timeoutMs: p.timeoutMs ?? 600_000,
    signal,
    onStatus: (s) =>
      console.error(
        `polling... ${describeStatus(s)} (${Math.round((Date.now() - startedAt) / 1000)}s)`,
      ),
  }).catch((e: unknown) => {
    if (signal.aborted || e instanceof JobTimeoutError) {
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
  printResult(p, provider.id, "video.generate", final.artifacts, final.usage)
}

async function runImageLane(provider: Provider, ctx: LaneContext): Promise<void> {
  const { p, model, signal } = ctx
  const api = provider.imageGenerate
  if (p.prompt === undefined) throw new Error("--prompt is required for image generation")
  if (p.firstFrame !== undefined || p.lastFrame !== undefined) {
    throw new Error("--first-frame/--last-frame only apply to video generation")
  }
  if (api === undefined) throw new Error("provider implements no image generation")
  const req = {
    model,
    prompt: p.prompt,
    options: p.opts,
    ...(p.image !== undefined ? { image: toFileRef(p.image, "--image") } : {}),
  }
  const result = await api.create(req, { signal })
  printResult(p, provider.id, "image.generate", result.artifacts, result.usage)
}

async function runEmbedLane(provider: Provider, ctx: LaneContext): Promise<void> {
  const { p, model } = ctx
  const api = provider.embed
  if (api === undefined) throw new Error("provider implements no embeddings")
  if (p.inputs.length === 0) throw new Error("--input is required for embeddings")
  const result = await api.create({ model, inputs: p.inputs, options: p.opts })
  if (p.json) {
    console.log(
      JSON.stringify({ provider: provider.id, model, capability: "embed", ...result }, null, 2),
    )
  } else {
    const dims = result.dimensions ?? result.vectors[0]?.length ?? "?"
    console.log(`Generated ${result.vectors.length} vector(s) of ${dims} dimensions`)
  }
}

async function runUnderstandLane(
  provider: Provider,
  ctx: LaneContext,
  lane: "image.understand" | "video.understand",
): Promise<void> {
  const { p, model } = ctx
  if (p.ask === undefined) throw new Error("--ask is required for understanding models")
  if (p.firstFrame !== undefined || p.lastFrame !== undefined) {
    throw new Error("--first-frame/--last-frame only apply to video generation")
  }
  const api =
    lane === "image.understand"
      ? (provider.imageUnderstand ?? provider.videoUnderstand)
      : (provider.videoUnderstand ?? provider.imageUnderstand)
  if (api === undefined) throw new Error("provider implements no understanding API")
  const content: (string | { file: FileRef; text?: string })[] = [
    p.ask,
    ...p.inputs.map(toContentPart),
  ]
  const result = await api.create({
    model,
    messages: [{ role: "user", content }],
    options: p.opts,
  })
  if (p.json) {
    console.log(
      JSON.stringify({ provider: provider.id, model, capability: lane, ...result }, null, 2),
    )
  } else {
    console.log(result.text)
  }
}

export async function runGenFromArgs(args: string[], opts: GenRunOptions = {}): Promise<void> {
  const p = parseGenArgs(args)

  if (p.target === undefined) {
    throw new Error(
      'expected <provider>/<model>, e.g. openmmcli gen zhipu/cogview-3-flash --prompt "..."',
    )
  }
  const slash = p.target.indexOf("/")
  const providerId = slash === -1 ? "" : p.target.slice(0, slash)
  const model = slash === -1 ? "" : p.target.slice(slash + 1)
  if (providerId === "" || model === "" || model.includes("/")) {
    throw new Error(`expected <provider>/<model>, got '${p.target}'`)
  }
  if (p.prompt !== undefined && p.ask !== undefined) {
    throw new Error("--prompt and --ask are mutually exclusive")
  }

  const provider = await createProvider(providerId, opts)
  if (!provider.models.some((m) => m.id === model)) {
    console.error(`note: '${model}' is not in ${providerId}'s verified list; passing through`)
  }
  const lane = resolveLane(provider, model, {
    prompt: p.prompt !== undefined,
    ask: p.ask !== undefined,
    inputs: p.inputs.length,
  })

  const controller = new AbortController()
  const onSignal = () => controller.abort()
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)

  const ctx: LaneContext = { p, model, signal: controller.signal }
  if (lane === "video.generate") return runVideoLane(provider, ctx)
  if (lane === "image.generate") return runImageLane(provider, ctx)
  if (lane === "embed") return runEmbedLane(provider, ctx)
  return runUnderstandLane(provider, ctx, lane)
}

function printResult(
  p: ParsedGenArgs,
  providerId: string,
  lane: Capability,
  artifacts: Artifact[],
  usage: Usage | undefined,
): void {
  if (p.json) {
    console.log(
      JSON.stringify({ provider: providerId, capability: lane, artifacts, usage }, null, 2),
    )
    return
  }
  printArtifacts(artifacts, { outputDir: p.outputDir })
}
