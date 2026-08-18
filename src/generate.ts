import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command } from "commander"
import { defaultGenProvider, loadConfig } from "./config"
import {
  buildResultPackage,
  GEN_CONFIG_MEDIA_TYPE,
  type GenSpec,
  type LoadedImage,
  loadGenImage,
  packageFsView,
  parseGenConfigBlob,
} from "./genPackage"
import {
  type Artifact,
  type Capability,
  createProvider,
  type FileRef,
  type JobHandle,
  JobTimeoutError,
  listConfiguredProviderIds,
  type ModelSupport,
  type Provider,
  ProviderError,
  pollUntil,
  type Usage,
} from "./providers"
import { fetchImage } from "./pull"
import { isLocalRef, looksLikeRegistryRef } from "./refs"
import {
  addGlobalOptions,
  collectValue,
  configOpts,
  parseArgsWith,
  parseDurationMs,
  parseKvValue,
  readPasswordFromStdin,
} from "./util"
import { type GenTaskName, TASKS, type TaskSpec } from "./tasks"

export { requestFieldsForTask, TASKS } from "./tasks"
export type { GenTaskName, TaskSpec } from "./tasks"

const TASK_LIST = Object.keys(TASKS).join(", ")

/** The canonical request: CLI flags, `-f` JSON, and recipe packages all map here. */
export interface GenRequest {
  task: GenTaskName
  /** Provider id, optionally "id/model" (positional sugar); overridable per field below. */
  provider?: string
  model?: string
  prompt?: string
  system?: string
  /** Reference images (URL / local path / pkg://path into a recipe package). */
  images?: string[]
  /** frames2video only. */
  firstFrame?: string
  /** frames2video only. */
  lastFrame?: string
  /** Media attachments (image2text/video2text) or texts (embed). */
  inputs?: string[]
  options?: Record<string, unknown>
  /** Video tasks: submit and print the task handle without polling. */
  noWait?: boolean
  /** Duration strings ("5m", "90s"); parsed and validated before execution. */
  timeout?: string
  interval?: string
  /** Result OCI layout dir (media tasks) or artifact save dir (resume / --no-pack). */
  output?: string
  /** Reference name for the result package (default gen-output:latest). */
  tag?: string
  /** Skip building a result package; print artifacts only. */
  noPack?: boolean
  json?: boolean
  /** resume only: inline handle JSON or a file path. */
  handle?: string
}

/** A partial request used as a merge overlay; absent fields do not override. */
export type RequestOverlay = { [K in keyof GenRequest]?: GenRequest[K] | undefined }

// ---------------------------------------------------------------------------
// CLI parsing (commander)

export interface GenerateCommandOptions {
  prompt?: string
  system?: string
  image?: string[]
  firstFrame?: string
  lastFrame?: string
  input?: string[]
  opt?: string[]
  timeout?: string
  interval?: string
  output?: string
  tag?: string
  provider?: string
  model?: string
  /** Set to false by --no-wait. */
  wait?: boolean
  /** Set to false by --no-pack. */
  pack?: boolean
  json?: boolean
  plainHttp?: boolean
  configDir?: string
}

export function addGenerateOptions(cmd: Command): Command {
  return cmd
    .option("--prompt <text>", "Alternative to the positional prompt")
    .option("--system <text>", "System prompt (text2text only)")
    .option(
      "--image <media>",
      "Reference image: URL, local path, or pkg://path (repeatable)",
      collectValue,
    )
    .option("--first-frame <img>", "First frame image (frames2video only)")
    .option("--last-frame <img>", "Last frame image (frames2video only)")
    .option(
      "--input <media>",
      "Attachment (image2text/video2text) or text (embed); repeatable",
      collectValue,
    )
    .option("--opt <k=v>", "Repeatable provider option (JSON-parsed when valid)", collectValue)
    .option("--timeout <dur>", "Polling timeout (e.g. 90s, 5m); video tasks and resume only")
    .option("--interval <dur>", "Polling interval (e.g. 1s); video tasks and resume only")
    .option("--output <dir>", "Result OCI layout directory (default ./oci-layout)")
    .option("--tag <repo:tag>", "Reference name for the result package (default gen-output:latest)")
    .option("--provider <id>", "Provider id (alternative to the positional provider)")
    .option("--model <id>", "Model id (requires --provider or a provider positional)")
    .option("--no-wait", "Submit a video task and print the handle without polling")
    .option("--no-pack", "Print artifacts only; do not build a result package")
    .option("--json", "Print structured JSON to stdout")
    .option("--plain-http", "Use HTTP for the registry (gen packages)")
}

export function buildGenerateTaskCommand(name: string): Command {
  const cmd = new Command(name).argument("[args...]")
  addGenerateOptions(cmd)
  return addGlobalOptions(cmd)
}

export interface ProviderContext {
  known: ReadonlySet<string>
  hasDefaultProvider: boolean
}

function parseOptRepeats(raw: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const item of raw) {
    const eq = item.indexOf("=")
    const key = eq === -1 ? "" : item.slice(0, eq)
    if (eq === -1 || key === "") {
      throw new Error(`invalid --opt '${item}' (expected k=v)`)
    }
    out[key] = parseKvValue(item.slice(eq + 1))
  }
  return out
}

/**
 * Split the first positional into the [provider] spec vs. payload positionals.
 * The first positional is a provider only when it contains "/" or matches a
 * known provider id; anything else is payload.
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

export interface ParseTaskOptions {
  /** Package mode: the ref consumed positional[0]; no provider positional. */
  packageMode?: boolean
}

/** Resolve the [provider] positional vs. payload positionals for a task. */
function resolvePositionals(
  task: GenTaskName,
  positionals: string[],
  ctx: ProviderContext,
  hasProviderFlags: boolean,
  packageMode: boolean,
): { target: string | undefined; payload: string[] } {
  if (packageMode || task === "resume") {
    return { target: undefined, payload: positionals }
  }
  if (hasProviderFlags) {
    const first = positionals[0]
    if (first !== undefined && (first.includes("/") || ctx.known.has(first))) {
      throw new Error(
        `conflicting provider specification: '${first}' and --provider/--model are mutually exclusive`,
      )
    }
    return { target: undefined, payload: positionals }
  }
  return splitProviderPositional(positionals, ctx)
}

/** Split a "provider[/model]" target string into its two fields. */
function splitTargetString(target: string): { provider: string; model: string | undefined } {
  const slash = target.indexOf("/")
  if (slash === -1) return { provider: target, model: undefined }
  const provider = target.slice(0, slash)
  const model = target.slice(slash + 1)
  if (provider === "" || model === "" || model.includes("/")) {
    throw new Error(`expected <provider>[/<model>], got '${target}'`)
  }
  return { provider, model }
}

function applyResumePayload(
  payload: string[],
  flagPrompt: string | undefined,
  overlay: RequestOverlay,
): void {
  if (payload.length > 1) {
    throw new Error(
      `too many positional arguments for resume (${payload.slice(1).join(" ")}); the form is: generate resume <handle|file>`,
    )
  }
  if (flagPrompt !== undefined) throw new Error("--prompt is not accepted by resume")
  if (payload[0] !== undefined) overlay.handle = payload[0]
}

function applyPromptPayload(
  task: GenTaskName,
  payload: string[],
  flagPrompt: string | undefined,
  overlay: RequestOverlay,
): void {
  if (payload.length > 1) {
    throw new Error(
      `too many positional arguments for ${task} (${payload.slice(1).join(" ")}); the form is: generate ${task} [provider] [prompt]`,
    )
  }
  if (payload[0] !== undefined && flagPrompt !== undefined) {
    throw new Error("--prompt and the positional prompt are mutually exclusive")
  }
  const prompt = payload[0] ?? flagPrompt
  if (prompt !== undefined) overlay.prompt = prompt
}

function applyInputsPayload(
  payload: string[],
  flagPrompt: string | undefined,
  flagInputs: string[],
  overlay: RequestOverlay,
): void {
  if (flagPrompt !== undefined) {
    throw new Error("embed takes text via --input or positionals, not --prompt")
  }
  const inputs = [...payload, ...flagInputs]
  if (inputs.length > 0) overlay.inputs = inputs
}

/** Apply the positional payload (prompt / inputs / handle) onto the overlay. */
function applyPositionalPayload(
  task: GenTaskName,
  payload: string[],
  flagPrompt: string | undefined,
  flagInputs: string[],
  overlay: RequestOverlay,
): void {
  if (task === "resume") {
    applyResumePayload(payload, flagPrompt, overlay)
  } else if (TASKS[task].payload === "prompt") {
    applyPromptPayload(task, payload, flagPrompt, overlay)
  } else {
    applyInputsPayload(payload, flagPrompt, flagInputs, overlay)
  }
}

/** Copy explicitly-passed flags onto the overlay. */
function collectFlagFields(
  task: GenTaskName,
  o: GenerateCommandOptions,
  overlay: RequestOverlay,
): void {
  collectScalarFlagFields(o, overlay)

  const images = o.image ?? []
  if (images.length > 0) overlay.images = images
  const inputs = o.input ?? []
  if (task !== "embed" && inputs.length > 0) overlay.inputs = inputs
  const options = parseOptRepeats(o.opt ?? [])
  if (Object.keys(options).length > 0) overlay.options = options
  if (o.wait === false) overlay.noWait = true
  if (o.pack === false) overlay.noPack = true
  if (o.json === true) overlay.json = true
}

function collectScalarFlagFields(o: GenerateCommandOptions, overlay: RequestOverlay): void {
  if (o.system !== undefined) overlay.system = o.system
  if (o.firstFrame !== undefined) overlay.firstFrame = o.firstFrame
  if (o.lastFrame !== undefined) overlay.lastFrame = o.lastFrame
  if (o.timeout !== undefined) overlay.timeout = o.timeout
  if (o.interval !== undefined) overlay.interval = o.interval
  if (o.output !== undefined) overlay.output = o.output
  if (o.tag !== undefined) overlay.tag = o.tag
}

/** Build the merge overlay for a task from explicitly-passed CLI fields only. */
function overlayFromParsed(
  task: GenTaskName,
  positionals: string[],
  o: GenerateCommandOptions,
  ctx: ProviderContext,
  opts: ParseTaskOptions,
): RequestOverlay {
  const hasProviderFlags = o.provider !== undefined || o.model !== undefined

  const { target, payload } = resolvePositionals(
    task,
    positionals,
    ctx,
    hasProviderFlags,
    opts.packageMode === true,
  )

  const overlay: RequestOverlay = { task }

  if (hasProviderFlags || target !== undefined) {
    const split = target !== undefined ? splitTargetString(target) : undefined
    const provider = split?.provider ?? o.provider
    const model = split?.model ?? o.model
    if (provider !== undefined) overlay.provider = provider
    if (model !== undefined) overlay.model = model
  }

  applyPositionalPayload(task, payload, o.prompt, o.input ?? [], overlay)
  collectFlagFields(task, o, overlay)

  return overlay
}

export function parseGenerateArgs(
  task: GenTaskName,
  args: string[],
  ctx: ProviderContext,
  opts: ParseTaskOptions = {},
): RequestOverlay {
  const { options, positionals } = parseArgsWith<GenerateCommandOptions>(
    buildGenerateTaskCommand(task),
    args,
  )
  return overlayFromParsed(task, positionals, options, ctx, opts)
}

// ---------------------------------------------------------------------------
// Validation

function fail(message: string): never {
  throw new Error(message)
}

function hasValue(v: string | undefined): boolean {
  return v !== undefined && v !== ""
}

function validateRequiredImages(spec: TaskSpec, req: GenRequest): void {
  if (spec.required.images !== 1) return
  const count = (req.images ?? []).length
  if (count === 0) {
    fail(`${req.task} requires --image <path|url|pkg://path>`)
  }
  if (count > 1) {
    fail(`${req.task} takes exactly one --image; multi-image generation is not supported yet`)
  }
}

/** Required-field checks. Throws with the missing flag. */
function validateRequired(spec: TaskSpec, req: GenRequest): void {
  if (spec.required.prompt && !hasValue(req.prompt)) {
    fail(`${req.task} requires a prompt (positional or --prompt)`)
  }
  validateRequiredImages(spec, req)
  if (spec.required.firstFrame && !hasValue(req.firstFrame)) {
    fail("frames2video requires --first-frame <img>")
  }
  if (spec.required.lastFrame && !hasValue(req.lastFrame)) {
    fail("frames2video requires --last-frame <img>")
  }
  if (spec.required.inputs && (req.inputs ?? []).length === 0) {
    fail(`${req.task} requires --input <media|text>`)
  }
  if (spec.required.handle && !hasValue(req.handle)) {
    fail("resume requires a handle (inline JSON, file path, or stdin)")
  }
}

function failForbiddenImages(req: GenRequest): void {
  if (req.task === "text2image") {
    fail("text2image does not take --image; image-to-image is `generate image2image --image ...`")
  }
  if (req.task === "text2video") {
    fail("text2video does not take --image; image-to-video is `generate image2video --image ...`")
  }
  if (req.task === "image2text" || req.task === "video2text") {
    fail(`${req.task} does not take --image; attachments use --input`)
  }
  fail(`${req.task} does not accept --image`)
}

function validateForbiddenTiming(spec: TaskSpec, req: GenRequest): void {
  if (req.noWait === true && spec.optional.noWait !== true) {
    fail(`--no-wait applies to video tasks only, not ${req.task}`)
  }
  if (hasValue(req.timeout) && spec.optional.timeout !== true) {
    fail(`--timeout applies to video tasks and resume only, not ${req.task}`)
  }
  if (hasValue(req.interval) && spec.optional.interval !== true) {
    fail(`--interval applies to video tasks and resume only, not ${req.task}`)
  }
}

/** Forbidden-field checks with guidance toward the right task. */
function validateForbidden(spec: TaskSpec, req: GenRequest): void {
  if ((req.images ?? []).length > 0 && spec.required.images === undefined) {
    failForbiddenImages(req)
  }
  const hasFrames = hasValue(req.firstFrame) || hasValue(req.lastFrame)
  if (hasFrames && spec.required.firstFrame === undefined) {
    failForbiddenFrames(req)
  }
  if (hasValue(req.system) && spec.optional.system !== true) {
    fail(`${req.task} does not accept --system (text2text only)`)
  }
  if (hasValue(req.prompt) && spec.required.prompt !== true && spec.optional.prompt !== true) {
    fail("embed takes text via --input or positionals, not a prompt")
  }
  if ((req.inputs ?? []).length > 0 && spec.required.inputs === undefined) {
    fail(`${req.task} does not accept --input`)
  }
  validateForbiddenTiming(spec, req)
  validateForbiddenPackaging(spec, req)
  if (hasValue(req.handle) && req.task !== "resume") {
    fail("a handle is only accepted by resume")
  }
}

function failForbiddenFrames(req: GenRequest): void {
  const flag = hasValue(req.firstFrame) ? "--first-frame" : "--last-frame"
  if (req.task === "text2video") {
    fail(`text2video does not take ${flag}; use \`generate image2video --image <img>\``)
  }
  if (req.task === "image2video") {
    fail(
      "image2video uses --image (it becomes the first frame); first+last frames belong to `generate frames2video`",
    )
  }
  fail(`${req.task} does not accept ${flag}`)
}

function validateForbiddenPackaging(spec: TaskSpec, req: GenRequest): void {
  const packaging = req.output !== undefined || req.tag !== undefined || req.noPack === true
  if (!packaging || spec.media || req.task === "resume") return
  const flag = req.output !== undefined ? "--output" : req.tag !== undefined ? "--tag" : "--no-pack"
  fail(`${flag} applies to media tasks (and resume for --output), not ${req.task}`)
}

/** Validate a merged request against its task contract. Throws with guidance. */
export function validateRequest(req: GenRequest): void {
  const spec = TASKS[req.task]
  if (spec === undefined) fail(`unknown generate task '${req.task}'`)

  validateRequired(spec, req)
  validateForbidden(spec, req)

  // Duration strings must parse
  if (hasValue(req.timeout)) parseDurationMs(req.timeout as string, "--timeout")
  if (hasValue(req.interval)) parseDurationMs(req.interval as string, "--interval")
}

/**
 * Merge an overlay onto a base request. Scalars override when set; arrays
 * (images, inputs) replace wholesale; options shallow-merge with overlay keys
 * winning. Absent overlay fields never override.
 */
export function mergeRequest(base: GenRequest, overlay: RequestOverlay): GenRequest {
  const out: GenRequest = { ...base }
  for (const key of Object.keys(overlay) as Array<keyof GenRequest>) {
    const value = overlay[key]
    if (value === undefined) continue
    if (key === "options") {
      out.options = { ...(base.options ?? {}), ...(overlay.options ?? {}) }
    } else if (key === "task") {
      out.task = value as GenTaskName
    } else {
      Object.assign(out, { [key]: value })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Provider / model resolution

export interface ResolvedTarget {
  provider: Provider
  model: string
}

export interface PickedModel {
  model: string
  /** True when the picked model is not verified for this task (passing through). */
  warned: boolean
}

/**
 * Pick the default model for a task: the provider's declared default for the
 * capability when it satisfies the task filter, else the first verified model
 * that does, else (non-strict tasks) any model with the capability plus a
 * warning. Strict tasks (frames2video) hard-fail instead of falling back.
 */
export function pickModelForTask(provider: Provider, task: GenTaskName): PickedModel {
  const spec = TASKS[task]
  const cap = spec.capability
  if (cap === undefined) fail(`task '${task}' has no model capability`)

  const filter = spec.pickModel
  const satisfies = (support: ModelSupport | undefined): boolean =>
    support !== undefined && (filter === undefined || filter(support))

  const declared = provider.defaultModels?.[cap]
  if (
    declared !== undefined &&
    satisfies(provider.models.find((m) => m.id === declared)?.capabilities[cap])
  ) {
    return { model: declared, warned: false }
  }

  const hit = provider.models.find((m) => satisfies(m.capabilities[cap]))
  if (hit !== undefined) {
    return { model: hit.id, warned: declared !== undefined && declared !== hit.id }
  }

  if (spec.strictModel === true) {
    fail(
      `provider '${provider.id}' has no verified model supporting ${task}; pass provider/<model> or --model explicitly`,
    )
  }

  const fallback = declared ?? provider.models.find((m) => m.capabilities[cap] !== undefined)?.id
  if (fallback === undefined) {
    fail(`provider '${provider.id}' has no model for ${cap}; specify provider/<model>`)
  }
  return { model: fallback, warned: true }
}

/** Resolve the request's provider/model, applying task-aware default model picking. */
export async function resolveProviderForTask(
  req: GenRequest,
  opts: { configPath?: string | undefined } = {},
): Promise<ResolvedTarget> {
  const spec = TASKS[req.task]
  if (spec.capability === undefined) {
    fail(`task '${req.task}' runs no provider`)
  }

  let providerId = ""
  let model = ""
  const target = req.provider
  if (target !== undefined && target !== "") {
    const split = splitTargetString(target)
    providerId = split.provider
    model = split.model ?? ""
  } else {
    providerId = defaultGenProvider(loadConfig(opts.configPath)) ?? ""
    if (providerId === "") {
      fail(
        "no <provider> given and no default provider configured; " +
          "set defaults.gen.provider via `openmmcli config set defaults.gen.provider <id>`",
      )
    }
  }
  if (req.model !== undefined && req.model !== "") model = req.model

  const provider = await createProvider(providerId, providerOpts(opts))
  if (model === "") {
    const picked = pickModelForTask(provider, req.task)
    if (picked.warned) {
      console.error(
        `note: '${picked.model}' is not marked as supporting ${req.task} in ${provider.id}'s verified list; passing through`,
      )
    }
    model = picked.model
  }
  return { provider, model }
}

function providerOpts(opts: { configPath?: string | undefined }): { configPath?: string } {
  return opts.configPath === undefined ? {} : { configPath: opts.configPath }
}

function providerContext(opts: { configPath?: string | undefined }): ProviderContext {
  const config = loadConfig(opts.configPath)
  return {
    known: new Set(listConfiguredProviderIds(providerOpts(opts))),
    hasDefaultProvider: defaultGenProvider(config) !== undefined,
  }
}

// ---------------------------------------------------------------------------
// Execution

export interface MediaRunResult {
  artifacts: Artifact[]
  usage: Usage | undefined
}

interface ExecCtx {
  req: GenRequest
  provider: Provider
  model: string
  signal: AbortSignal
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

async function runTextTask(ctx: ExecCtx): Promise<void> {
  const { req, provider, model, signal } = ctx
  const api = provider.textGenerate
  if (api === undefined) fail(`provider '${provider.id}' implements no text generation`)
  const result = await api.create(
    {
      model,
      prompt: req.prompt ?? "",
      ...(req.system === undefined ? {} : { system: req.system }),
      options: req.options ?? {},
    },
    { signal },
  )
  if (req.json) {
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

async function runUnderstandTask(ctx: ExecCtx): Promise<void> {
  const { req, provider, model, signal } = ctx
  const api = req.task === "image2text" ? provider.imageUnderstand : provider.videoUnderstand
  const kind = req.task === "image2text" ? "image" : "video"
  if (api === undefined) fail(`provider '${provider.id}' implements no ${kind} understanding`)
  const content: (string | { file: FileRef; text?: string })[] = [
    req.prompt ?? `Describe this ${kind}.`,
    ...(req.inputs ?? []).map(toContentPart),
  ]
  const result = await api.create(
    {
      model,
      messages: [{ role: "user", content }],
      options: req.options ?? {},
    },
    { signal },
  )
  if (req.json) {
    console.log(
      JSON.stringify(
        { provider: provider.id, model, capability: `${kind}.understand`, ...result },
        null,
        2,
      ),
    )
  } else {
    console.log(result.text)
  }
}

async function runEmbedTask(ctx: ExecCtx): Promise<void> {
  const { req, provider, model, signal } = ctx
  const api = provider.embed
  if (api === undefined) fail(`provider '${provider.id}' implements no embeddings`)
  const result = await api.create(
    { model, inputs: req.inputs ?? [], options: req.options ?? {} },
    { signal },
  )
  if (req.json) {
    console.log(
      JSON.stringify({ provider: provider.id, model, capability: "embed", ...result }, null, 2),
    )
  } else {
    const dims = result.dimensions ?? result.vectors[0]?.length ?? "?"
    console.log(`Generated ${result.vectors.length} vector(s) of ${dims} dimensions`)
  }
}

async function runImageTask(ctx: ExecCtx): Promise<MediaRunResult> {
  const { req, provider, model, signal } = ctx
  const api = provider.imageGenerate
  if (api === undefined) fail(`provider '${provider.id}' implements no image generation`)
  const images = req.images ?? []
  const result = await api.create(
    {
      model,
      prompt: req.prompt ?? "",
      options: req.options ?? {},
      ...(images.length > 0 ? { image: toFileRef(images[0] as string, "--image") } : {}),
    },
    { signal },
  )
  return { artifacts: result.artifacts, usage: result.usage }
}

async function runVideoTask(ctx: ExecCtx): Promise<MediaRunResult | null> {
  const { req, provider, model, signal } = ctx
  const api = provider.videoGenerate
  if (api === undefined) fail(`provider '${provider.id}' implements no video generation`)
  const first = req.task === "frames2video" ? req.firstFrame : (req.images ?? [])[0]
  const last = req.task === "frames2video" ? req.lastFrame : undefined

  const handle = await api.submit(
    {
      model,
      prompt: req.prompt ?? "",
      options: req.options ?? {},
      ...(first !== undefined ? { firstFrame: toFileRef(first, "--first-frame/--image") } : {}),
      ...(last !== undefined ? { lastFrame: toFileRef(last, "--last-frame") } : {}),
    },
    { signal },
  )
  if (req.noWait === true) {
    console.log(JSON.stringify(handle))
    return null
  }

  const timeoutMs = req.timeout === undefined ? 600_000 : parseDurationMs(req.timeout, "--timeout")
  const intervalMs = req.interval === undefined ? 5000 : parseDurationMs(req.interval, "--interval")

  const startedAt = Date.now()
  const final = await pollUntil((h) => api.poll(h, { signal }), handle, {
    intervalMs,
    timeoutMs,
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

/** Run a task; media tasks return their artifacts/usage for result packaging. */
async function executeTask(ctx: ExecCtx): Promise<MediaRunResult | null> {
  switch (ctx.req.task) {
    case "text2text":
      await runTextTask(ctx)
      return null
    case "image2text":
    case "video2text":
      await runUnderstandTask(ctx)
      return null
    case "embed":
      await runEmbedTask(ctx)
      return null
    case "text2image":
    case "image2image":
      return runImageTask(ctx)
    case "text2video":
    case "image2video":
    case "frames2video":
      return runVideoTask(ctx)
    default:
      fail(`task '${ctx.req.task}' is not executable here`)
  }
}

// ---------------------------------------------------------------------------
// resume

function parseHandle(raw: string): JobHandle {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    fail("handle is not valid JSON")
  }
  const handle = value as Partial<JobHandle>
  if (typeof handle.providerId !== "string" || handle.providerId === "") {
    fail("handle JSON must have a non-empty string 'providerId'")
  }
  if (typeof handle.id !== "string" || handle.id === "") {
    fail("handle JSON must have a non-empty string 'id'")
  }
  return handle as JobHandle
}

async function runResumeTask(
  req: GenRequest,
  opts: { configPath?: string | undefined },
): Promise<void> {
  let raw: string | undefined
  if (req.handle !== undefined) {
    raw = req.handle.startsWith("{") ? req.handle : readFileSync(req.handle, "utf8")
  } else if (!process.stdin.isTTY) {
    raw = await readPasswordFromStdin()
  }
  if (raw === undefined) fail("resume requires a handle (inline JSON, file path, or stdin)")
  const handle = parseHandle(raw.trim())

  const provider = await createProvider(handle.providerId, providerOpts(opts))
  const api = provider.videoGenerate
  if (api === undefined) {
    fail(`provider '${handle.providerId}' implements no video generation`)
  }

  const controller = new AbortController()
  const onSignal = () => controller.abort()
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)

  const timeoutMs = req.timeout === undefined ? 600_000 : parseDurationMs(req.timeout, "--timeout")
  const intervalMs = req.interval === undefined ? 5000 : parseDurationMs(req.interval, "--interval")

  const startedAt = Date.now()
  let final: Awaited<ReturnType<typeof pollUntil>>
  try {
    final = await pollUntil((h) => api.poll(h, { signal: controller.signal }), handle, {
      intervalMs,
      timeoutMs,
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
  } finally {
    process.off("SIGINT", onSignal)
    process.off("SIGTERM", onSignal)
  }

  if (final.state === "failed") {
    throw new ProviderError(
      final.error.category,
      `generation failed (task ${handle.id})`,
      final.error.raw,
    )
  }
  if (req.json) {
    console.log(
      JSON.stringify(
        { provider: provider.id, artifacts: final.artifacts, usage: final.usage },
        null,
        2,
      ),
    )
  } else {
    printArtifacts(final.artifacts, { outputDir: req.output })
  }
}

// ---------------------------------------------------------------------------
// Result packaging

/** Provenance spec recorded in a result package: the effective merged request. */
export function effectiveGenSpec(req: GenRequest, providerId: string, model: string): GenSpec {
  const spec: GenSpec = { task: req.task, provider: providerId, model }
  if (req.prompt !== undefined) spec.prompt = req.prompt
  if (req.system !== undefined) spec.system = req.system
  if (req.images !== undefined && req.images.length > 0) spec.images = req.images
  if (req.firstFrame !== undefined) spec.firstFrame = req.firstFrame
  if (req.lastFrame !== undefined) spec.lastFrame = req.lastFrame
  if (req.inputs !== undefined && req.inputs.length > 0) spec.inputs = req.inputs
  if (req.options !== undefined && Object.keys(req.options).length > 0) spec.options = req.options
  return spec
}

function printResult(req: GenRequest, providerId: string, result: MediaRunResult): void {
  const capability: Capability =
    req.task === "text2image" || req.task === "image2image" ? "image.generate" : "video.generate"
  if (req.json) {
    console.log(
      JSON.stringify(
        {
          provider: providerId,
          capability,
          artifacts: result.artifacts,
          usage: result.usage,
        },
        null,
        2,
      ),
    )
    return
  }
  printArtifacts(result.artifacts, { outputDir: undefined })
}

function printPackagedResult(
  req: GenRequest,
  providerId: string,
  result: MediaRunResult,
  packageRef: string,
  packageDir: string,
): void {
  if (req.json) {
    const capability: Capability =
      req.task === "text2image" || req.task === "image2image" ? "image.generate" : "video.generate"
    console.log(
      JSON.stringify(
        {
          provider: providerId,
          capability,
          artifacts: result.artifacts,
          usage: result.usage,
          package: { ref: packageRef, dir: packageDir },
        },
        null,
        2,
      ),
    )
    return
  }
  result.artifacts.forEach((a, i) => {
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

/** Execute a validated request: run the task and package media results. */
async function executeAndPackage(opts: {
  req: GenRequest
  runReq: GenRequest
  provider: Provider
  model: string
  fromRef?: string
}): Promise<void> {
  const { req, runReq, provider, model } = opts
  const controller = new AbortController()
  const onSignal = () => controller.abort()
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)

  try {
    const ctx: ExecCtx = { req: runReq, provider, model, signal: controller.signal }
    const result = await executeTask(ctx)
    if (result === null) return

    if (req.noPack === true || !TASKS[req.task].media) {
      printResult(req, provider.id, result)
      return
    }

    const outputDir = req.output ?? "./oci-layout"
    const resultTag = req.tag ?? "gen-output:latest"
    await buildResultPackage({
      outputDir,
      tag: resultTag,
      ...(opts.fromRef === undefined ? {} : { fromRef: opts.fromRef }),
      artifacts: result.artifacts,
      spec: effectiveGenSpec(req, provider.id, model),
      usage: result.usage,
    })
    printPackagedResult(req, provider.id, result, resultTag, outputDir)
  } finally {
    process.off("SIGINT", onSignal)
    process.off("SIGTERM", onSignal)
  }
}

/** Run a request built programmatically (CLI args, `-f` files, callers). */
export async function runGenerateRequest(
  req: GenRequest,
  opts: GenerateRunOptions = {},
): Promise<void> {
  validateRequest(req)
  if (req.task === "resume") return runResumeTask(req, opts)
  rejectPkgRefsOutsidePackageMode(req)
  const { provider, model } = await resolveProviderForTask(req, opts)
  await executeAndPackage({ req, runReq: req, provider, model })
}

// ---------------------------------------------------------------------------
// Package (recipe) mode

/** True when the first positional is a package ref rather than a task. */
function looksLikeGenRef(arg: string): boolean {
  if (isLocalRef(arg)) return true
  return looksLikeRegistryRef(arg)
}

/**
 * Materialize pkg:// media references (images / frames / inputs) into temp
 * files extracted from the package layers. Non-pkg values pass through.
 */
async function materializePackageMedia(
  req: GenRequest,
  image: LoadedImage,
): Promise<{ req: GenRequest; cleanup: () => void }> {
  const usesPkg =
    (req.images ?? []).some((v) => v.startsWith("pkg://")) ||
    (req.firstFrame?.startsWith("pkg://") ?? false) ||
    (req.lastFrame?.startsWith("pkg://") ?? false) ||
    (req.inputs ?? []).some((v) => v.startsWith("pkg://"))
  if (!usesPkg) return { req, cleanup: () => {} }

  const view = await packageFsView(image)
  const tmp = mkdtempSync(join(tmpdir(), "openmm-pkgref-"))
  const extract = (value: string | undefined): string | undefined => {
    if (value === undefined || !value.startsWith("pkg://")) return value
    const rel = value.slice("pkg://".length)
    const entry = view.get(rel)
    if (entry === undefined || entry.type !== "file") {
      fail(`package media ref '${value}': '${rel}' not found in the package layers`)
    }
    const base = rel.split("/").pop() ?? "file"
    const out = join(tmp, base)
    writeFileSync(out, entry.data)
    return out
  }

  const images = req.images?.map((v) => extract(v) ?? v)
  const firstFrame = extract(req.firstFrame)
  const lastFrame = extract(req.lastFrame)
  const inputs = req.inputs?.map((v) => extract(v) ?? v)

  return {
    req: {
      ...req,
      ...(images !== undefined ? { images } : {}),
      ...(firstFrame !== undefined ? { firstFrame } : {}),
      ...(lastFrame !== undefined ? { lastFrame } : {}),
      ...(inputs !== undefined ? { inputs } : {}),
    },
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  }
}

async function runGeneratePackage(
  ref: string,
  positionals: string[],
  options: GenerateCommandOptions,
  opts: { configPath?: string | undefined } = {},
): Promise<void> {
  const plainHttp = options.plainHttp === true

  const image = await loadGenImage(ref, { plainHttp, configPath: opts.configPath }, fetchImage)
  if (image.manifest.config.mediaType !== GEN_CONFIG_MEDIA_TYPE) {
    fail(
      `${ref}: not a gen package (config mediaType ${image.manifest.config.mediaType}); ` +
        "build one by adding a 'gen' field to openmm-build.json",
    )
  }
  const configBlob = image.blobs.get(image.manifest.config.digest)
  if (configBlob === undefined) {
    fail(`${ref}: config blob ${image.manifest.config.digest} is missing from the layout`)
  }
  const recipe = parseGenConfigBlob(configBlob, ref).gen

  const overlay = overlayFromParsed(recipe.task, positionals, options, providerContext(opts), {
    packageMode: true,
  })
  const req = mergeRequest({ ...recipe, task: recipe.task }, overlay)

  if (req.task === "resume") return runResumeTask(req, opts)
  validateRequest(req)

  const { provider, model } = await resolveProviderForTask(req, opts)
  const { req: runReq, cleanup } = await materializePackageMedia(req, image)

  try {
    await executeAndPackage({ req, runReq, provider, model, fromRef: ref })
  } finally {
    cleanup()
  }
}

// ---------------------------------------------------------------------------
// Entry point

/** pkg:// references only resolve inside package mode. */
function rejectPkgRefsOutsidePackageMode(req: GenRequest): void {
  const fields = [
    ...(req.images ?? []),
    ...(req.inputs ?? []),
    ...(req.firstFrame !== undefined ? [req.firstFrame] : []),
    ...(req.lastFrame !== undefined ? [req.lastFrame] : []),
  ]
  if (fields.some((v) => v.startsWith("pkg://"))) {
    fail("`pkg://` media references only work with `openmmcli generate <ref>` (a gen package)")
  }
}

export interface GenerateRunOptions {
  configPath?: string | undefined
}

const TASK_DESCRIPTIONS: Record<GenTaskName, string> = {
  text2text: "Text chat completion (text in, text out)",
  image2text: "Ask a question about image(s)",
  video2text: "Ask a question about video(s)",
  text2image: "Generate an image from text",
  image2image: "Generate an image from an image and text",
  text2video: "Generate a video from text",
  image2video: "Generate a video from an image and text",
  frames2video: "Generate a video from first and last frames",
  embed: "Embed text as vectors",
  resume: "Resume polling a saved video task",
}

/**
 * The `generate` command tree: one subcommand per task plus a parent handler
 * for the `generate <ref>` package mode and unknown tasks.
 */
export function buildGenerateCommand(): Command {
  const gen = new Command("generate")
    .usage("<task>")
    .description(
      "Generate media by task (text2image, image2image, text2video, ...) or run a gen package ref",
    )
  // Options after the first operand belong to the task subcommand (or to the
  // `generate <ref>` handler, which re-parses them); only --config-dir is
  // consumed here.
  gen.enablePositionalOptions()
  addGlobalOptions(gen)
  gen.allowExcessArguments(true)
  // Trailing flags after a `<ref>` (or a non-task operand) land in `unknown`;
  // allow them through so the parent handler can re-parse them.
  gen.allowUnknownOption()

  for (const task of Object.keys(TASKS) as GenTaskName[]) {
    const cmd = gen.command(task).description(TASK_DESCRIPTIONS[task])
    addGenerateOptions(cmd)
    addGlobalOptions(cmd)
    cmd.argument("[args...]")
    cmd.addHelpText("after", `\n${TASKS[task].usage}`)
    cmd.action(async (args: string[], options: GenerateCommandOptions, command: Command) => {
      const opts = configOpts(command, options.configDir)
      const overlay = overlayFromParsed(task, args, options, providerContext(opts), {})
      await runGenerateRequest(mergeRequest({ task }, overlay), opts)
    })
  }

  gen.action(async (options: { configDir?: string }, command: Command) => {
    const args = command.args
    if (args.length === 0) {
      command.help()
      return
    }
    const head = args[0] as string
    if (looksLikeGenRef(head)) {
      // The trailing operands include the task flags; parse them here.
      const { options: taskOpts, positionals } = parseArgsWith<GenerateCommandOptions>(
        buildGenerateTaskCommand("ref"),
        args.slice(1),
      )
      await runGeneratePackage(
        head,
        positionals,
        taskOpts,
        configOpts(command, taskOpts.configDir, options.configDir),
      )
      return
    }
    fail(`unknown generate task '${head}' (expected ${TASK_LIST}, or a gen package ref)`)
  })

  return gen
}
