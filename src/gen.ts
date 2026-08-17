import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultGenProvider, loadConfig } from "./config"
import {
  buildResultPackage,
  GEN_CONFIG_MEDIA_TYPE,
  type GenSpec,
  parseGenConfigBlob,
} from "./genPackage"
import { type FsView, mergeImageLayers } from "./layers"
import { type LoadedImage, readOciLayout } from "./oci"
import {
  type Artifact,
  type Capability,
  createProvider,
  type FileRef,
  type JobHandle,
  JobTimeoutError,
  listConfiguredProviderIds,
  type Provider,
  ProviderError,
  pollUntil,
  type Usage,
} from "./providers"
import { fetchImage } from "./pull"
import { parseCliArgs, parseDurationMs, parseKvValue, readPasswordFromStdin } from "./util"

export const GEN_USAGE = `Usage: openmmcli gen <lane> [provider] [args]
   or: openmmcli gen <ref> [prompt] [options]     Run a gen package

Generate text/image/video, understand media, or compute embeddings via a
provider model. The lane is explicit; the model comes from <provider> (as
\`provider\` or \`provider/model\`), from the provider's default model for
that lane, or from the default provider (config key defaults.gen.provider).
A <ref> (e.g. example.com/xxxxxx:v1.0) instead of a lane runs a gen package
built with \`openmmcli package build\` (see \`openmmcli gen <ref> --help\`).

Lanes:
  text        Text chat completion       openmmcli gen text <provider> [prompt]
  image       Image generation           openmmcli gen image <provider> [prompt]
  video       Video generation (async)   openmmcli gen video <provider> [prompt]
  understand  Ask a question about media openmmcli gen understand <provider> [question]
  embed       Compute text embeddings    openmmcli gen embed <provider> [input...]
  resume      Resume a saved video task  openmmcli gen resume <handle|file>

Run \`openmmcli gen <lane> --help\` for lane details.

Progress and notes go to stderr; results go to stdout.`

export const GEN_TEXT_USAGE = `Usage: openmmcli gen text <provider> [prompt]

Text chat completion via a provider model (e.g. zhipu/glm-4-flash,
ark/doubao-seed-1-6-250615). With no <provider>, the default provider from
config (defaults.gen.provider) is used; with no model, the provider's default
text model is used.

Arguments:
  <provider>            provider id or provider/model (e.g. zhipu or zhipu/glm-4-flash)
  [prompt]              the message to send (or use --prompt)

Options:
      --prompt <text>   Alternative to the positional prompt
      --system <text>   System prompt
      --opt <k=v>       Repeatable provider-specific option; the value is
                        parsed as JSON when valid (5 → 5, true → true), else
                        kept as a string. Force a string with --opt 'k="v"'
      --json            Print structured JSON to stdout
  -h, --help            Show this help message`

export const GEN_IMAGE_USAGE = `Usage: openmmcli gen image <provider> [prompt]

Generate images via a provider model. With no <provider>, the default provider
from config (defaults.gen.provider) is used; with no model, the provider's
default image model is used.

Arguments:
  <provider>            provider id or provider/model (e.g. zhipu/cogview-3-flash)
  [prompt]              generation instruction (or use --prompt)

Options:
      --prompt <text>   Alternative to the positional prompt
      --image <path|url>  Reference image for image generation
      --opt <k=v>       Repeatable provider option (JSON-parsed when valid)
      --output <dir>    Directory to save base64-only artifacts
      --json            Print structured JSON to stdout
  -h, --help            Show this help message`

export const GEN_VIDEO_USAGE = `Usage: openmmcli gen video <provider> [prompt]

Generate videos via a provider model (async; polls until done). With no
<provider>, the default provider from config (defaults.gen.provider) is used;
with no model, the provider's default video model is used.

Arguments:
  <provider>            provider id or provider/model (e.g. ark/doubao-seedance-2.0)
  [prompt]              generation instruction (or use --prompt)

Options:
      --prompt <text>   Alternative to the positional prompt
      --first-frame <path|url>  Video first frame / reference image
      --last-frame <path|url>   Video last frame
      --opt <k=v>       Repeatable provider option (JSON-parsed when valid)
      --no-wait         Submit and print the task handle as one line of JSON,
                        then exit (resume with \`openmmcli gen resume\`)
      --timeout <dur>   Polling timeout (default 10m; e.g. 90s, 5m, 600)
      --interval <dur>  Polling interval (default 5s)
      --output <dir>    Directory to save base64-only artifacts
      --json            Print structured JSON to stdout
  -h, --help            Show this help message`

export const GEN_UNDERSTAND_USAGE = `Usage: openmmcli gen understand <provider> [question]

Ask a question about attached media (images/videos) via a vision model. With
no <provider>, the default provider from config (defaults.gen.provider) is
used; with no model, the provider's default understanding model is used.

Arguments:
  <provider>            provider id or provider/model
                        (e.g. ark/doubao-1.5-vision-pro-32k-250115)
  [question]            the question to ask (or use --ask)

Options:
      --ask <text>      Alternative to the positional question
      --input <text|path|url>  Repeatable. Attachments (http(s)/data URL or
                        existing path = file, otherwise plain text)
      --opt <k=v>       Repeatable provider option (JSON-parsed when valid)
      --json            Print structured JSON to stdout
  -h, --help            Show this help message`

export const GEN_EMBED_USAGE = `Usage: openmmcli gen embed <provider> [input...]

Compute text embeddings via a provider model. With no <provider>, the default
provider from config (defaults.gen.provider) is used; with no model, the
provider's default embedding model is used.

Arguments:
  <provider>            provider id or provider/model
                        (e.g. ark/doubao-embedding-large-text-240915)
  [input...]            texts to embed (or use --input)

Options:
      --input <text|path|url>  Repeatable. Text, URL, or existing path
      --opt <k=v>       Repeatable provider option (JSON-parsed when valid)
      --json            Print structured JSON to stdout
  -h, --help            Show this help message`

export const GEN_RESUME_USAGE = `Usage: openmmcli gen resume <handle|file> [options]

Resume polling a video generation task saved by \`gen video --no-wait\`.

Arguments:
  <handle|file>         The task handle: inline JSON (starts with "{") or a
                        path to a file containing it. When omitted, reads the
                        handle from stdin.

Options:
      --timeout <dur>   Polling timeout (default 10m; e.g. 90s, 5m, 600)
      --interval <dur>  Polling interval (default 5s)
      --output <dir>    Directory to save base64-only artifacts
      --json            Print structured JSON to stdout
  -h, --help            Show this help message`

export const GEN_PACKAGE_USAGE = `Usage: openmmcli gen <ref> [prompt] [options]

Run generation from a gen package built by \`openmmcli package build\` (its
manifest has a \`gen\` field). The package carries the lane, provider, model,
and parameters; API keys are resolved locally at run time, never from the
package. <ref> is a registry reference (e.g. example.com/xxxxxx:v1.0) or a
local OCI layout path (e.g. ./oci-layout).

Arguments:
  <ref>                 Package reference (registry or local layout)
  [prompt]              Overrides the package's default prompt (text/image/
                        video/understand lanes)

Options:
      --prompt <text>   Alternative to the positional prompt
      --system <text>   Overrides the package's system prompt (text)
      --ask <text>      Question for understand lanes
      --input <x>       Repeatable attachments/inputs (understand/embed)
      --image <ref>     Overrides the package's reference image
      --first-frame <ref>  Overrides the video first frame
      --last-frame <ref>   Overrides the video last frame
      --opt <k=v>       Repeatable; merged over the package's options
      --no-wait         (video) submit and print the task handle, no polling
      --timeout <dur>   Polling timeout (default 10m)
      --interval <dur>  Polling interval (default 5s)
      --output <dir>    Result OCI layout directory (default ./oci-layout)
      --tag <repo:tag>  Reference name for the result package
                        (default gen-output:latest)
      --no-pack         Print artifacts only; do not build a result package
      --plain-http      Use HTTP for the registry (local registries)
      --json            Print structured JSON to stdout
  -h, --help            Show this help message

Media references (<image> / <first-frame> / <last-frame> / <input>) accept an
http(s)/data URL, a local path, or a \`pkg://path\` that points at a file inside
the package's layers (e.g. \`pkg://refs/cat.png\` packed by the \`assets\` dir).`

export type GenLane = "text" | "image" | "video" | "understand" | "embed" | "resume"

/** Lane → capabilities used to pick a default model (understand prefers image). */
const LANE_CAPABILITIES: Partial<Record<GenLane, Capability[]>> = {
  text: ["text.generate"],
  image: ["image.generate"],
  video: ["video.generate"],
  understand: ["image.understand", "video.understand"],
  embed: ["embed"],
}

const LANE_USAGES: Record<GenLane, string> = {
  text: GEN_TEXT_USAGE,
  image: GEN_IMAGE_USAGE,
  video: GEN_VIDEO_USAGE,
  understand: GEN_UNDERSTAND_USAGE,
  embed: GEN_EMBED_USAGE,
  resume: GEN_RESUME_USAGE,
}

const COMMON_VALUES: Record<string, string> = { "--opt": "opt" }
const COMMON_REPEATS = new Set(["--opt"])

const LANE_VALUE_OPTS: Partial<Record<GenLane, Record<string, string>>> = {
  text: { ...COMMON_VALUES, "--prompt": "prompt", "--system": "system" },
  image: { ...COMMON_VALUES, "--prompt": "prompt", "--image": "image", "--output": "output" },
  video: {
    ...COMMON_VALUES,
    "--prompt": "prompt",
    "--first-frame": "firstFrame",
    "--last-frame": "lastFrame",
    "--timeout": "timeout",
    "--interval": "interval",
    "--output": "output",
  },
  understand: { ...COMMON_VALUES, "--ask": "ask", "--input": "input" },
  embed: { ...COMMON_VALUES, "--input": "input" },
  resume: { "--timeout": "timeout", "--interval": "interval", "--output": "output" },
}

const LANE_BOOL_FLAGS: Partial<Record<GenLane, Record<string, string>>> = {
  text: { "--json": "json" },
  image: { "--json": "json" },
  video: { "--no-wait": "noWait", "--json": "json" },
  understand: { "--json": "json" },
  embed: { "--json": "json" },
  resume: { "--json": "json" },
}

const LANE_REPEATS: Partial<Record<GenLane, ReadonlySet<string>>> = {
  understand: new Set([...COMMON_REPEATS, "--input"]),
  embed: new Set([...COMMON_REPEATS, "--input"]),
}

export interface ParsedGenArgs {
  lane: GenLane
  target: string | undefined
  prompt: string | undefined
  system: string | undefined
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
  /** resume lane: inline handle JSON, a file path, or undefined (stdin). */
  source: string | undefined
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

export interface ProviderContext {
  known: ReadonlySet<string>
  hasDefaultProvider: boolean
}

/**
 * Split the first positional into the <provider> spec vs. payload positionals
 * (prompt/question/inputs). The first positional is a provider only when it
 * contains "/" or matches a known provider id; anything else is payload,
 * which requires a configured default provider.
 */
export function splitProviderPositional(
  positionals: string[],
  ctx: ProviderContext,
): { target: string | undefined; payload: string[] } {
  const first = positionals[0]
  if (first !== undefined && (first.includes("/") || ctx.known.has(first))) {
    return { target: first, payload: positionals.slice(1) }
  }
  if (first !== undefined && !ctx.hasDefaultProvider) {
    throw new Error(
      `expected <provider>, got '${first}' (known providers: ${[...ctx.known].join(", ") || "none configured"}); ` +
        "or set defaults.gen.provider via `openmmcli config set defaults.gen.provider <id>`",
    )
  }
  return { target: undefined, payload: positionals }
}

/** Maximum payload positionals per lane; 0 means unlimited (embed). */
const MAX_PAYLOAD: Partial<Record<GenLane, number>> = {
  text: 1,
  image: 1,
  video: 1,
  understand: 1,
  resume: 1,
}

/** Resolve the prompt/question from positional and flag triggers, rejecting conflicts. */
function resolveLanePrompt(
  lane: GenLane,
  positional: string | undefined,
  flagPrompt: string | undefined,
  flagAsk: string | undefined,
): string | undefined {
  if (lane === "understand") {
    if (positional !== undefined && flagAsk !== undefined) {
      throw new Error("--ask and the positional question are mutually exclusive")
    }
    return positional ?? flagAsk
  }
  if (positional !== undefined && flagPrompt !== undefined) {
    throw new Error("--prompt and the positional prompt are mutually exclusive")
  }
  return positional ?? flagPrompt
}

export function parseGenArgs(lane: GenLane, args: string[], ctx: ProviderContext): ParsedGenArgs {
  const values = LANE_VALUE_OPTS[lane] ?? {}
  const flags = LANE_BOOL_FLAGS[lane] ?? {}
  const repeats = LANE_REPEATS[lane] ?? COMMON_REPEATS
  const parsed = parseCliArgs(args, { values, flags, repeats })

  const { target, payload } =
    lane === "resume"
      ? { target: undefined, payload: parsed.positionals }
      : splitProviderPositional(parsed.positionals, ctx)
  const max = MAX_PAYLOAD[lane]
  if (max !== undefined && payload.length > max) {
    throw new Error(
      `too many positional arguments for gen ${lane} (${payload.slice(1).join(" ")}); ` +
        "the form is: openmmcli gen " +
        (lane === "resume"
          ? "resume <handle|file>"
          : `${lane} <provider> [${lane === "understand" ? "question" : "prompt"}]`),
    )
  }

  const prompt = resolveLanePrompt(
    lane,
    payload[0],
    single(parsed.values["prompt"]),
    single(parsed.values["ask"]),
  )

  const timeout = single(parsed.values["timeout"])
  const interval = single(parsed.values["interval"])
  const inputs =
    lane === "embed" ? [...payload, ...many(parsed.values["input"])] : many(parsed.values["input"])
  return {
    lane,
    target,
    prompt,
    system: single(parsed.values["system"]),
    inputs,
    firstFrame: single(parsed.values["firstFrame"]),
    lastFrame: single(parsed.values["lastFrame"]),
    image: single(parsed.values["image"]),
    opts: parseOptRepeats(parsed.values["opt"]),
    noWait: parsed.flags["noWait"] === true,
    json: parsed.flags["json"] === true,
    timeoutMs: timeout === undefined ? undefined : parseDurationMs(timeout, "--timeout"),
    intervalMs: interval === undefined ? undefined : parseDurationMs(interval, "--interval"),
    outputDir: single(parsed.values["output"]),
    source: lane === "resume" ? payload[0] : undefined,
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

export interface ResolvedTarget {
  provider: Provider
  model: string
}

/** Result of a media lane (image/video) after a successful run. */
export interface MediaRunResult {
  artifacts: Artifact[]
  usage: Usage | undefined
}

/**
 * Pick the model for a lane: the provider's declared default for that
 * capability, else the first verified model supporting it.
 */
export function pickDefaultModel(provider: Provider, caps: Capability[]): string | undefined {
  for (const cap of caps) {
    const declared = provider.defaultModels?.[cap]
    if (declared !== undefined && declared !== "") return declared
  }
  for (const cap of caps) {
    const verified = provider.models.find((m) => m.capabilities[cap] !== undefined)
    if (verified !== undefined) return verified.id
  }
  return undefined
}

function providerContext(opts: GenRunOptions): ProviderContext {
  const config = loadConfig(opts.configPath)
  return {
    known: new Set(listConfiguredProviderIds(opts)),
    hasDefaultProvider: defaultGenProvider(config) !== undefined,
  }
}

/**
 * Resolve <provider>[/<model>] for a lane. When the target omits the model
 * (or the whole target), falls back to the provider's default model for the
 * lane, and to the config's default provider (defaults.gen.provider).
 */
export async function resolveProviderForLane(
  target: string | undefined,
  lane: GenLane,
  opts: GenRunOptions = {},
): Promise<ResolvedTarget> {
  const caps = LANE_CAPABILITIES[lane]
  if (caps === undefined) {
    throw new Error(`lane '${lane}' has no model capability`)
  }

  let providerId: string
  let model = ""
  if (target !== undefined) {
    const slash = target.indexOf("/")
    if (slash !== -1) {
      providerId = target.slice(0, slash)
      model = target.slice(slash + 1)
      if (providerId === "" || model === "" || model.includes("/")) {
        throw new Error(`expected <provider>[/<model>], got '${target}'`)
      }
    } else {
      providerId = target
    }
  } else {
    providerId = defaultGenProvider(loadConfig(opts.configPath)) ?? ""
    if (providerId === "") {
      throw new Error(
        "no <provider> given and no default provider configured; " +
          "set defaults.gen.provider via `openmmcli config set defaults.gen.provider <id>`",
      )
    }
  }

  const provider = await createProvider(providerId, opts)
  if (model === "") {
    const picked = pickDefaultModel(provider, caps)
    if (picked === undefined) {
      throw new Error(
        `provider '${provider.id}' has no default model for ${caps.join("/")} and no verified model supports it; specify <provider>/<model>`,
      )
    }
    model = picked
  }
  return { provider, model }
}

async function runTextLane(provider: Provider, ctx: LaneContext): Promise<void> {
  const { p, model } = ctx
  const api = provider.textGenerate
  if (api === undefined) throw new Error(`provider '${provider.id}' implements no text generation`)
  if (p.prompt === undefined) throw new Error("a prompt is required for text generation")
  const result = await api.create({
    model,
    prompt: p.prompt,
    ...(p.system === undefined ? {} : { system: p.system }),
    options: p.opts,
  })
  if (p.json) {
    console.log(
      JSON.stringify(
        { provider: provider.id, model, capability: "text.generate", ...result },
        null,
        2,
      ),
    )
  } else {
    console.log(result.text)
  }
}

async function runImageLane(provider: Provider, ctx: LaneContext): Promise<MediaRunResult> {
  const { p, model, signal } = ctx
  const api = provider.imageGenerate
  if (p.prompt === undefined) throw new Error("a prompt is required for image generation")
  if (api === undefined) throw new Error(`provider '${provider.id}' implements no image generation`)
  const result = await api.create(
    {
      model,
      prompt: p.prompt,
      options: p.opts,
      ...(p.image !== undefined ? { image: toFileRef(p.image, "--image") } : {}),
    },
    { signal },
  )
  return { artifacts: result.artifacts, usage: result.usage }
}

async function runVideoLane(provider: Provider, ctx: LaneContext): Promise<MediaRunResult | null> {
  const { p, model, signal } = ctx
  const videoApi = provider.videoGenerate
  if (p.prompt === undefined) throw new Error("a prompt is required for video generation")
  if (videoApi === undefined) {
    throw new Error(`provider '${provider.id}' implements no video generation`)
  }
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
    return null
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
  return { artifacts: final.artifacts, usage: final.usage }
}

async function runEmbedLane(provider: Provider, ctx: LaneContext): Promise<void> {
  const { p, model } = ctx
  const api = provider.embed
  if (api === undefined) throw new Error(`provider '${provider.id}' implements no embeddings`)
  if (p.inputs.length === 0) {
    throw new Error("at least one input is required for embeddings (positional or --input)")
  }
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

async function runUnderstandLane(provider: Provider, ctx: LaneContext): Promise<void> {
  const { p, model } = ctx
  if (p.prompt === undefined) throw new Error("a question is required for understanding models")
  const api = provider.imageUnderstand ?? provider.videoUnderstand
  if (api === undefined)
    throw new Error(`provider '${provider.id}' implements no understanding API`)
  const content: (string | { file: FileRef; text?: string })[] = [
    p.prompt,
    ...p.inputs.map(toContentPart),
  ]
  const result = await api.create({
    model,
    messages: [{ role: "user", content }],
    options: p.opts,
  })
  if (p.json) {
    console.log(
      JSON.stringify(
        { provider: provider.id, model, capability: "image.understand", ...result },
        null,
        2,
      ),
    )
  } else {
    console.log(result.text)
  }
}

function parseHandle(raw: string): JobHandle {
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

async function runResumeLane(p: ParsedGenArgs, opts: GenRunOptions = {}): Promise<void> {
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
    printArtifacts(final.artifacts, { outputDir: p.outputDir })
  }
}

/** True when the first gen positional is a package ref rather than a lane. */
function looksLikeGenRef(arg: string): boolean {
  if (arg.startsWith(".") || arg.startsWith("/")) return true
  const slash = arg.indexOf("/")
  if (slash <= 0) return false
  const first = arg.slice(0, slash)
  return first.includes(".") || first.includes(":") || first === "localhost"
}

interface PackageFlags {
  rest: string[]
  plainHttp: boolean
  tag: string | undefined
  noPack: boolean
}

function extractPackageFlags(args: string[]): PackageFlags {
  const rest: string[] = []
  let plainHttp = false
  let noPack = false
  let tag: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) continue
    if (arg === "--plain-http") {
      plainHttp = true
    } else if (arg === "--no-pack") {
      noPack = true
    } else if (arg === "--tag") {
      const value = args[i + 1]
      if (value === undefined || value === "") throw new Error("--tag requires a <repo:tag> value")
      i++
      tag = value
    } else {
      rest.push(arg)
    }
  }
  return { rest, plainHttp, tag, noPack }
}

/** Parse package-mode args: every positional is payload (prompt/inputs), never a provider. */
function parseGenPackageArgs(lane: GenLane, args: string[]): ParsedGenArgs {
  const values = LANE_VALUE_OPTS[lane] ?? {}
  const flags = LANE_BOOL_FLAGS[lane] ?? {}
  const repeats = LANE_REPEATS[lane] ?? COMMON_REPEATS
  const parsed = parseCliArgs(args, { values, flags, repeats })

  const payload = parsed.positionals
  const max = MAX_PAYLOAD[lane]
  if (max !== undefined && payload.length > max) {
    const payloadName =
      lane === "understand" ? "question" : lane === "embed" ? "input..." : "prompt"
    throw new Error(
      `too many positional arguments for gen ${lane} (${payload.slice(1).join(" ")}); ` +
        `the form is: openmmcli gen <ref> [${payloadName}]`,
    )
  }

  const prompt = resolveLanePrompt(
    lane,
    payload[0],
    single(parsed.values["prompt"]),
    single(parsed.values["ask"]),
  )

  const timeout = single(parsed.values["timeout"])
  const interval = single(parsed.values["interval"])
  const inputs =
    lane === "embed" ? [...payload, ...many(parsed.values["input"])] : many(parsed.values["input"])
  return {
    lane,
    target: undefined,
    prompt,
    system: single(parsed.values["system"]),
    inputs,
    firstFrame: single(parsed.values["firstFrame"]),
    lastFrame: single(parsed.values["lastFrame"]),
    image: single(parsed.values["image"]),
    opts: parseOptRepeats(parsed.values["opt"]),
    noWait: parsed.flags["noWait"] === true,
    json: parsed.flags["json"] === true,
    timeoutMs: timeout === undefined ? undefined : parseDurationMs(timeout, "--timeout"),
    intervalMs: interval === undefined ? undefined : parseDurationMs(interval, "--interval"),
    outputDir: single(parsed.values["output"]),
    source: undefined,
  }
}

/** CLI overrides win over the recipe; options merge shallowly (CLI wins per key). */
function mergeRecipeIntoArgs(recipe: GenSpec, p: ParsedGenArgs): ParsedGenArgs {
  return {
    ...p,
    prompt: p.prompt ?? recipe.prompt,
    system: p.system ?? recipe.system,
    opts: { ...(recipe.options ?? {}), ...p.opts },
    image: p.image ?? recipe.image,
    firstFrame: p.firstFrame ?? recipe.firstFrame,
    lastFrame: p.lastFrame ?? recipe.lastFrame,
    inputs: p.inputs.length > 0 ? p.inputs : (recipe.input ?? []),
  }
}

function recipeTarget(recipe: GenSpec): string | undefined {
  const provider = recipe.provider
  if (provider === undefined) return undefined
  if (provider.includes("/")) {
    if (recipe.model === undefined) return provider
    const id = provider.slice(0, provider.indexOf("/"))
    return `${id}/${recipe.model}`
  }
  return recipe.model === undefined ? provider : `${provider}/${recipe.model}`
}

function effectiveGenSpec(
  lane: GenLane,
  providerId: string,
  model: string,
  p: ParsedGenArgs,
): GenSpec {
  const spec: GenSpec = { lane, provider: providerId, model }
  if (p.prompt !== undefined) spec.prompt = p.prompt
  if (p.system !== undefined) spec.system = p.system
  if (Object.keys(p.opts).length > 0) spec.options = p.opts
  if (p.image !== undefined) spec.image = p.image
  if (p.firstFrame !== undefined) spec.firstFrame = p.firstFrame
  if (p.lastFrame !== undefined) spec.lastFrame = p.lastFrame
  if (p.inputs.length > 0) spec.input = p.inputs
  return spec
}

async function loadGenImage(
  ref: string,
  opts: { plainHttp: boolean; configPath?: string | undefined },
): Promise<LoadedImage> {
  if (ref.startsWith(".") || ref.startsWith("/")) {
    return readOciLayout(ref)
  }
  return fetchImage(ref, {
    plainHttp: opts.plainHttp,
    username: undefined,
    password: undefined,
    config: loadConfig(opts.configPath),
  })
}

/** Merge every layer of a gen package into a single file view. */
async function packageFsView(image: LoadedImage): Promise<FsView> {
  const layerBlobs: Buffer[] = []
  for (const layer of image.manifest.layers) {
    const blob = image.blobs.get(layer.digest)
    if (blob === undefined) {
      throw new Error(`layer blob ${layer.digest} is missing from the package`)
    }
    layerBlobs.push(blob)
  }
  if (layerBlobs.length === 0) return new Map()
  return (await mergeImageLayers(layerBlobs)).view
}

/**
 * Materialize `pkg://path` media references (image / frames / inputs) into
 * temp files extracted from the package layers, so the lane runners can hand
 * them to providers as local files. Returns the rewritten args and a cleanup
 * function. Non-pkg values are left untouched.
 */
async function materializePackageMedia(
  p: ParsedGenArgs,
  image: LoadedImage,
): Promise<{ p: ParsedGenArgs; cleanup: () => void }> {
  const usesPkg =
    p.image?.startsWith("pkg://") === true ||
    p.firstFrame?.startsWith("pkg://") === true ||
    p.lastFrame?.startsWith("pkg://") === true ||
    p.inputs.some((v) => v.startsWith("pkg://"))
  if (!usesPkg) return { p, cleanup: () => {} }

  const view = await packageFsView(image)
  const tmp = mkdtempSync(join(tmpdir(), "openmm-pkgref-"))
  const extract = (value: string | undefined): string | undefined => {
    if (value === undefined || !value.startsWith("pkg://")) return value
    const rel = value.slice("pkg://".length)
    const entry = view.get(rel)
    if (entry === undefined || entry.type !== "file") {
      throw new Error(`package media ref '${value}': '${rel}' not found in the package layers`)
    }
    const base = rel.split("/").pop() ?? "file"
    const out = join(tmp, base)
    writeFileSync(out, entry.data)
    return out
  }

  return {
    p: {
      ...p,
      image: extract(p.image),
      firstFrame: extract(p.firstFrame),
      lastFrame: extract(p.lastFrame),
      inputs: p.inputs.map((v) => extract(v) ?? v),
    },
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  }
}

async function executeLane(
  lane: GenLane,
  provider: Provider,
  ctx: LaneContext,
): Promise<MediaRunResult | null> {
  switch (lane) {
    case "text":
      await runTextLane(provider, ctx)
      return null
    case "image":
      return runImageLane(provider, ctx)
    case "video":
      return runVideoLane(provider, ctx)
    case "embed":
      await runEmbedLane(provider, ctx)
      return null
    case "understand":
      await runUnderstandLane(provider, ctx)
      return null
    default:
      throw new Error(`unknown gen lane '${lane}'`)
  }
}

function printPackagedResult(
  p: ParsedGenArgs,
  providerId: string,
  capability: Capability,
  artifacts: Artifact[],
  usage: Usage | undefined,
  packageRef: string,
  packageDir: string,
): void {
  if (p.json) {
    console.log(
      JSON.stringify(
        {
          provider: providerId,
          capability,
          artifacts,
          usage,
          package: { ref: packageRef, dir: packageDir },
        },
        null,
        2,
      ),
    )
    return
  }
  artifacts.forEach((a, i) => {
    if (a.url !== undefined) {
      console.log(a.url)
      return
    }
    if (a.base64 === undefined) return
    const ext = (a.mimeType && MIME_EXT[a.mimeType]) || "bin"
    console.log(`artifact-${i + 1}.${ext}`)
  })
  console.error(`Built ${packageRef} → ${packageDir}`)
}

async function runGenPackage(ref: string, rest: string[], opts: GenRunOptions = {}): Promise<void> {
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(GEN_PACKAGE_USAGE)
    return
  }
  const { rest: laneArgs, plainHttp, tag, noPack } = extractPackageFlags(rest)

  const image = await loadGenImage(ref, { plainHttp, configPath: opts.configPath })
  if (image.manifest.config.mediaType !== GEN_CONFIG_MEDIA_TYPE) {
    throw new Error(
      `${ref}: not a gen package (config mediaType ${image.manifest.config.mediaType}); ` +
        "build one by adding a 'gen' field to openmm-build.json",
    )
  }
  const configBlob = image.blobs.get(image.manifest.config.digest)
  if (configBlob === undefined) {
    throw new Error(
      `${ref}: config blob ${image.manifest.config.digest} is missing from the layout`,
    )
  }
  const { gen: recipe } = parseGenConfigBlob(configBlob, ref)
  const lane = recipe.lane

  const p = mergeRecipeIntoArgs(recipe, parseGenPackageArgs(lane, laneArgs))

  const { provider, model } = await resolveProviderForLane(recipeTarget(recipe), lane, opts)
  if (!provider.models.some((m) => m.id === model)) {
    console.error(`note: '${model}' is not in ${provider.id}'s verified list; passing through`)
  }

  const { p: runP, cleanup } = await materializePackageMedia(p, image)

  const controller = new AbortController()
  const onSignal = () => controller.abort()
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)

  try {
    const ctx: LaneContext = { p: runP, model, signal: controller.signal }
    const result = await executeLane(lane, provider, ctx)

    if (result === null) return

    const capability: Capability = lane === "image" ? "image.generate" : "video.generate"
    if (noPack) {
      printResult(p, provider.id, capability, result.artifacts, result.usage)
      return
    }

    const outputDir = p.outputDir ?? "./oci-layout"
    const resultTag = tag ?? "gen-output:latest"
    await buildResultPackage({
      outputDir,
      tag: resultTag,
      fromRef: ref,
      artifacts: result.artifacts,
      spec: effectiveGenSpec(lane, provider.id, model, p),
      usage: result.usage,
    })
    printPackagedResult(
      p,
      provider.id,
      capability,
      result.artifacts,
      result.usage,
      resultTag,
      outputDir,
    )
  } finally {
    cleanup()
  }
}

export async function runGenFromArgs(args: string[], opts: GenRunOptions = {}): Promise<void> {
  const head = args[0]
  if (head === undefined || head === "--help" || head === "-h") {
    console.log(GEN_USAGE)
    return
  }
  if (looksLikeGenRef(head)) {
    return runGenPackage(head, args.slice(1), opts)
  }
  const lane = head
  const laneUsage = LANE_USAGES[lane as GenLane]
  if (laneUsage === undefined) {
    throw new Error(
      `unknown gen lane '${lane}' (expected text, image, video, understand, embed, resume, or a gen package ref)`,
    )
  }
  const rest = args.slice(1)
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(laneUsage)
    return
  }

  const p = parseGenArgs(lane as GenLane, rest, providerContext(opts))

  if (lane === "resume") {
    return runResumeLane(p, opts)
  }

  const { provider, model } = await resolveProviderForLane(p.target, lane as GenLane, opts)
  if (!provider.models.some((m) => m.id === model)) {
    console.error(`note: '${model}' is not in ${provider.id}'s verified list; passing through`)
  }

  const controller = new AbortController()
  const onSignal = () => controller.abort()
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)

  const ctx: LaneContext = { p, model, signal: controller.signal }
  const result = await executeLane(lane as GenLane, provider, ctx)
  if (result !== null) {
    const capability: Capability = lane === "image" ? "image.generate" : "video.generate"
    printResult(p, provider.id, capability, result.artifacts, result.usage)
  }
}

function printResult(
  p: ParsedGenArgs,
  providerId: string,
  capability: Capability,
  artifacts: Artifact[],
  usage: Usage | undefined,
): void {
  if (p.json) {
    console.log(JSON.stringify({ provider: providerId, capability, artifacts, usage }, null, 2))
    return
  }
  printArtifacts(artifacts, { outputDir: p.outputDir })
}
