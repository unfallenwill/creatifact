import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command } from "commander"

import { defaultGenProvider, envForConfigPath, loadConfig, storeDir } from "./config"
import { artifactExtension, fetchArtifactBytes } from "./download"
import { CliError, usageError } from "./errors"
import { ok, status, warn } from "./format"
import {
  artifactFromStore,
  buildResultPackage,
  GEN_CONFIG_MEDIA_TYPE,
  type GenSpec,
  type InputProvenance,
  type LoadedImage,
  loadGenImage,
  packageFsView,
  parseGenConfigBlob,
  type StepProvenance,
} from "./genPackage"
import { interruptSignal } from "./interrupt"
import { emitResult } from "./output"
import {
  type Artifact,
  type Capability,
  createProvider,
  type FileRef,
  type JobHandle,
  JobTimeoutError,
  listConfiguredProviderIds,
  listProviderCatalog,
  type ModelSupport,
  type Provider,
  ProviderError,
  pollUntil,
  type Usage,
} from "./providers"
import { fetchImage } from "./pull"
import { isLocalRef, looksLikeRegistryRef } from "./refs"
import { type GenTaskName, modelSupportsTask, TASKS, type TaskSpec } from "./tasks"
import {
  addGlobalOptions,
  collectValue,
  configOpts,
  parseArgsWith,
  parseDurationMs,
  parseKvValue,
  prettyOpts,
  readPasswordFromStdin,
} from "./util"

export type { GenTaskName, TaskSpec } from "./tasks"
export { requestFieldsForTask, TASKS } from "./tasks"

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
  /** Internal: prompt provenance recorded by pipeline runs (not a CLI/-f field). */
  promptRef?: StepProvenance
  /** Internal: media-input provenance recorded by pipeline runs. */
  inputRefs?: InputProvenance[]
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
  /** Skip building a result package; return artifacts only. */
  noPack?: boolean
  /** resume only: inline handle JSON or a file path. */
  handle?: string
}

/** A partial request used as a merge overlay; absent fields do not override. */
export type RequestOverlay = { [K in keyof GenRequest]?: GenRequest[K] | undefined }

// ---------------------------------------------------------------------------
// CLI parsing (commander)

export interface GenerateCommandOptions {
  prompt?: string
  /** Read the prompt from a file (mutually exclusive with --prompt/positional). */
  promptFile?: string
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
  /** Meta flag: list models supporting the task, then exit. */
  listModels?: boolean
  plainHttp?: boolean
  configDir?: string
}

export function addGenerateOptions(cmd: Command): Command {
  return cmd
    .option("--prompt <text>", "Alternative to the positional prompt")
    .option(
      "--prompt-file <path>",
      "Read the prompt from a file (alternative to --prompt/positional)",
    )
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
    .option(
      "--output <dir>",
      "Export a standalone result layout dir (default: store ~/.creatifact/store)",
    )
    .option("--tag <repo:tag>", "Reference name for the result package (default gen-output:latest)")
    .option("--provider <id>", "Provider id (alternative to the positional provider)")
    .option("--model <id>", "Model id (requires --provider or a provider positional)")
    .option("--no-wait", "Submit a video task and return the handle without polling")
    .option("--no-pack", "Return artifacts only; do not build a result package")
    .option("--plain-http", "Use HTTP for the registry (gen packages)")
}

/**
 * Register ONLY the flags a task's spec allows. The TaskSpec in tasks.ts is
 * the single source of truth: runtime validation (validateRequest), the `-f`
 * JSON field whitelist (requestFieldsForTask), and this flag surface all
 * derive from it, so --help can never advertise a flag the task rejects —
 * inapplicable flags fail at parse time as unknown options instead of
 * surfacing as runtime errors after credential/provider resolution.
 */
/** One CLI flag plus the spec predicate that makes it apply to a task. */
interface TaskFlagSpec {
  add: (cmd: Command, task: GenTaskName) => void
  when: (spec: TaskSpec, task: GenTaskName) => boolean
}

const TASK_FLAGS: TaskFlagSpec[] = [
  {
    when: (s) => Boolean(s.required.prompt || s.optional.prompt),
    add: (cmd) => cmd.option("--prompt <text>", "Alternative to the positional prompt"),
  },
  {
    when: (s) => Boolean(s.required.prompt || s.optional.prompt),
    add: (cmd) =>
      cmd.option("--prompt-file <path>", "Read the prompt from a file (not with --prompt)"),
  },
  {
    when: (s) => s.optional.system === true,
    add: (cmd) => cmd.option("--system <text>", "System prompt"),
  },
  {
    when: (s) => s.required.images !== undefined,
    add: (cmd) =>
      cmd.option(
        "--image <media>",
        "Reference image: URL, local path, or pkg://path (repeatable)",
        collectValue,
      ),
  },
  {
    when: (s) => s.required.firstFrame === true,
    add: (cmd) => cmd.option("--first-frame <img>", "First frame image (required)"),
  },
  {
    when: (s) => s.required.lastFrame === true,
    add: (cmd) => cmd.option("--last-frame <img>", "Last frame image (required)"),
  },
  {
    when: (s) => s.required.inputs === true,
    add: (cmd, task) => {
      const kind =
        task === "embed"
          ? "Repeatable text, URL, or path"
          : `Repeatable ${task === "image2text" ? "image" : "video"} (URL, path, pkg://path)`
      cmd.option("--input <media>", kind, collectValue)
    },
  },
  {
    when: (s) => s.optional.options === true,
    add: (cmd) =>
      cmd.option(
        "--opt <k=v>",
        "Repeatable provider option (JSON-parsed when valid)",
        collectValue,
      ),
  },
  {
    when: (s) => s.optional.noWait === true,
    add: (cmd) => cmd.option("--no-wait", "Submit and return the task handle, then exit"),
  },
  {
    when: (s) => s.optional.timeout === true,
    add: (cmd) => cmd.option("--timeout <dur>", "Polling timeout (default 10m; e.g. 90s, 5m)"),
  },
  {
    when: (s) => s.optional.interval === true,
    add: (cmd) => cmd.option("--interval <dur>", "Polling interval (default 5s)"),
  },
  {
    when: (_s, task) => task === "resume",
    add: (cmd) => cmd.option("--output <dir>", "Directory to save base64-only artifacts"),
  },
  {
    when: (s) => s.media,
    add: (cmd) => cmd.option("--no-pack", "Return artifacts only; do not build a result package"),
  },
  {
    when: (s) => s.media || s.packable === true,
    add: (cmd) => {
      cmd.option(
        "--output <dir>",
        "Result OCI layout directory (default ~/.creatifact/layouts/<repo>)",
      )
      cmd.option("--tag <repo:tag>", "Reference name for the result package")
    },
  },
  {
    when: (_s, task) => task !== "resume",
    add: (cmd) => {
      cmd.option("--provider <id>", "Provider id (alternative to the positional provider)")
      cmd.option("--model <id>", "Model id (requires --provider or a provider positional)")
      cmd.option("--list-models", "List models that support this task (with defaults), then exit")
    },
  },
]

export function addTaskOptions(cmd: Command, task: GenTaskName): Command {
  const spec = TASKS[task]
  for (const flag of TASK_FLAGS) {
    if (flag.when(spec, task)) flag.add(cmd, task)
  }
  return cmd
}

/** Positional arguments per task, derived from the same spec (help text). */
function addTaskArguments(cmd: Command, task: GenTaskName): void {
  const spec = TASKS[task]
  if (task === "resume") {
    cmd.argument("[handle|file]", "Task handle JSON, file path, or stdin when omitted")
    return
  }
  cmd.argument("[provider]", "Provider id or provider/model (e.g. ark/doubao-seedance-2.0)")
  if (spec.payload === "inputs") {
    cmd.argument("[input...]", "Texts to embed (or use --input)")
    return
  }
  const question = spec.capability?.endsWith("understand") === true
  cmd.argument(
    question ? "[question]" : "[prompt]",
    question
      ? "Optional question (or use --prompt); defaults to describing the input"
      : "Generation instruction (or use --prompt)",
  )
}

/** A task subcommand: spec-filtered flags + described positionals. */
export function buildGenerateTaskCommand(task: GenTaskName): Command {
  const cmd = new Command(task)
  addTaskOptions(cmd, task)
  addTaskArguments(cmd, task)
  return addGlobalOptions(cmd)
}

/**
 * The `generate <ref>` handler re-parses trailing flags BEFORE the package's
 * embedded task is known, so the ref parser must accept every task's flags
 * (validation happens later against the ref's own task spec).
 */
export function buildRefTaskCommand(): Command {
  const cmd = new Command("ref").argument("[args...]")
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
      throw usageError(`invalid --opt '${item}' (expected k=v)`)
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
        "or set defaults.gen.provider via `creatifact config set defaults.gen.provider <id>`",
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

/** Read --prompt-file content (trimmed); empty files and IO failures are caller errors. */
function readPromptFile(path: string): string {
  let content: string
  try {
    content = readFileSync(path, "utf8")
  } catch (e) {
    throw usageError(`cannot read --prompt-file '${path}': ${(e as Error).message}`)
  }
  const prompt = content.trim()
  if (prompt === "") {
    throw usageError(`--prompt-file '${path}' is empty`)
  }
  return prompt
}

/** The effective --prompt value: --prompt-file's content when given, else --prompt. */
function resolveFlagPrompt(o: GenerateCommandOptions): string | undefined {
  if (o.promptFile === undefined) return o.prompt
  if (o.prompt !== undefined) {
    throw usageError("--prompt-file and --prompt are mutually exclusive")
  }
  return readPromptFile(o.promptFile)
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

  applyPositionalPayload(task, payload, resolveFlagPrompt(o), o.input ?? [], overlay)
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
  throw usageError(message)
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
  if (req.noPack === true && !spec.media) {
    fail(`--no-pack applies to media tasks (they pack by default), not ${req.task}`)
  }
  const packaging = req.output !== undefined || req.tag !== undefined
  if (!packaging) return
  if (spec.media || spec.packable === true || req.task === "resume") return
  const flag = req.output !== undefined ? "--output" : "--tag"
  fail(`${flag} applies to result-packaging tasks (media, text, embed) and resume, not ${req.task}`)
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

export interface ListModelsResult {
  provider: string
  model: string
  default: boolean
  note?: string | undefined
}

/** Collect one provider's supported models + its default resolution. */
async function collectProviderEntries(
  id: string,
  task: GenTaskName,
  opts: { configPath?: string },
): Promise<{
  entries: ListModelsResult[]
  fallback: ListModelsResult | undefined
  defaultId: string | undefined
}> {
  const { provider } = await listProviderCatalog(
    id,
    opts.configPath === undefined ? {} : { configPath: opts.configPath },
  )
  const supported = provider.models.filter((m) => modelSupportsTask(m, task))
  let defaultId: string | undefined
  try {
    defaultId = pickModelForTask(provider, task).model
  } catch {
    const cap = TASKS[task].capability
    defaultId = cap !== undefined ? provider.defaultModels?.[cap] : undefined
  }
  const entries = supported.map((m) => ({
    provider: id,
    model: m.id,
    default: m.id === defaultId,
    ...(m.note === undefined ? {} : { note: m.note }),
  }))
  // The declared default fails the task filter: runtime would warn and pass
  // through — surface that instead of hiding it.
  const fallback =
    defaultId !== undefined && !supported.some((m) => m.id === defaultId)
      ? {
          provider: id,
          model: defaultId,
          default: false,
          note: "default; not verified for this task (passes through with a warning)",
        }
      : undefined
  return { entries, fallback, defaultId }
}

/**
 * The --list-models payload: every verified model supporting the task, across
 * the requested providers (or all configured ones), with the task-level
 * default (exactly what pickModelForTask would choose) starred. Falls back to
 * the declared capability default when it does not pass the filter — shown
 * with a fallback note, mirroring the runtime warning.
 */
export async function listModelsForTask(
  task: GenTaskName,
  providerScope: string | undefined,
  opts: { configPath?: string } = {},
): Promise<{ providers: string[]; entries: ListModelsResult[]; fallback?: ListModelsResult }> {
  const ids = providerScope !== undefined ? [providerScope] : listConfiguredProviderIds(opts)
  const entries: ListModelsResult[] = []
  let fallback: ListModelsResult | undefined
  for (const id of ids) {
    const collected = await collectProviderEntries(id, task, opts)
    entries.push(...collected.entries)
    fallback = fallback ?? collected.fallback
  }
  return { providers: ids, entries, ...(fallback === undefined ? {} : { fallback }) }
}

/** The --list-models payload: supported models plus the fallback default. */
async function runListModels(
  task: GenTaskName,
  positionals: string[],
  options: GenerateCommandOptions,
  opts: { configPath?: string | undefined },
): Promise<GenerateResult> {
  const ctx = providerContext(opts)
  const { target } = splitProviderPositional(positionals, ctx)
  const scope =
    options.provider ?? (target !== undefined ? splitTargetString(target).provider : undefined)
  const result = await listModelsForTask(
    task,
    scope,
    opts.configPath === undefined ? {} : { configPath: opts.configPath },
  )
  if (result.entries.length === 0) {
    warn(
      `no verified model supports ${task}${scope !== undefined ? ` on '${scope}'` : ""}; run \`creatifact models\` for the full catalog`,
    )
  }
  return {
    task,
    models: {
      entries: result.entries,
      ...(result.fallback === undefined ? {} : { fallback: result.fallback }),
    },
  }
}

/** Cross-provider suggestion block for errors/warnings; "" when nothing helps. */
async function suggestModelsForTask(
  task: GenTaskName,
  opts: { configPath?: string | undefined },
): Promise<string> {
  try {
    const { entries } = await listModelsForTask(
      task,
      undefined,
      opts.configPath === undefined ? {} : { configPath: opts.configPath },
    )
    if (entries.length === 0) return ""
    // Breadth over completeness: up to 3 per provider, 9 lines total — the
    // agent needs any valid candidate to self-correct; --list-models has the rest.
    const perProvider = new Map<string, number>()
    const lines: string[] = []
    for (const e of entries) {
      const used = perProvider.get(e.provider) ?? 0
      if (used >= 3 || lines.length >= 9) continue
      perProvider.set(e.provider, used + 1)
      lines.push(`  ${e.provider}/${e.model}`)
    }
    return [
      `models that support ${task}:`,
      ...lines,
      `run \`creatifact generate ${task} --list-models\` for more`,
    ].join("\n")
  } catch {
    return "" // suggestions are best-effort; never mask the original error
  }
}

/** Resolve provider id + explicit model from the request's target forms. */
function resolveTargetIds(
  req: GenRequest,
  opts: { configPath?: string | undefined },
): { providerId: string; model: string } {
  const target = req.provider
  if (target !== undefined && target !== "") {
    const split = splitTargetString(target)
    if (split.model !== undefined) return { providerId: split.provider, model: split.model }
    // Bare provider positional: an explicit --model (no slash) still applies.
    if (req.model !== undefined && req.model !== "" && !req.model.includes("/")) {
      return { providerId: split.provider, model: req.model }
    }
    return { providerId: split.provider, model: "" }
  }
  if (req.model?.includes("/")) {
    // --model <provider>/<model> shorthand: carries the provider too
    const split = splitTargetString(req.model)
    return { providerId: split.provider, model: split.model ?? "" }
  }
  const providerId = defaultGenProvider(loadConfig(opts.configPath)) ?? ""
  if (providerId === "") {
    fail(
      "no <provider> given and no default provider configured; " +
        "set defaults.gen.provider via `creatifact config set defaults.gen.provider <id>`, " +
        "or use --model <provider>/<model>",
    )
  }
  if (req.model !== undefined && req.model !== "") {
    return { providerId, model: req.model }
  }
  return { providerId, model: "" }
}

/**
 * Default-pick with inline suggestions on hard failure, or verify an explicit
 * model against the registry (pass-through with a warning when mismatched).
 */
async function resolveModelForTask(
  provider: Provider,
  task: GenTaskName,
  model: string,
  opts: { configPath?: string | undefined },
): Promise<string> {
  if (model !== "") {
    // Explicit model known to the registry but not verified for this task:
    // pass through (philosophy) but warn with the better candidates inline.
    const known = provider.models.find((m) => m.id === model)
    if (known !== undefined && !modelSupportsTask(known, task)) {
      const suggestion = await suggestModelsForTask(task, opts)
      warn(
        `'${model}' is not marked as supporting ${task} in ${provider.id}'s verified list; passing through` +
          (suggestion === "" ? "" : `\n${suggestion}`),
      )
    }
    return model
  }
  let picked: PickedModel | undefined
  try {
    picked = pickModelForTask(provider, task)
  } catch (e) {
    // Inline the candidates right where the agent is looking: one failed
    // call becomes self-correcting instead of prompting a discovery detour.
    const suggestion = await suggestModelsForTask(task, opts)
    fail(suggestion === "" ? (e as Error).message : `${(e as Error).message}\n${suggestion}`)
  }
  if (picked === undefined) fail("unreachable: pickModelForTask returned nothing")
  if (picked.warned) {
    warn(
      `'${picked.model}' is not marked as supporting ${task} in ${provider.id}'s verified list; passing through`,
    )
  }
  return picked.model
}

/** Resolve the request's provider/model, applying task-aware default model picking. */
export async function resolveProviderForTask(
  req: GenRequest,
  opts: { configPath?: string | undefined } = {},
): Promise<ResolvedTarget> {
  if (TASKS[req.task].capability === undefined) {
    fail(`task '${req.task}' runs no provider`)
  }
  const { providerId, model } = resolveTargetIds(req, opts)
  const provider = await createProvider(providerId, providerOpts(opts))
  return { provider, model: await resolveModelForTask(provider, req.task, model, opts) }
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
    throw usageError(`${flag} file not found: ${value} (or pass an http(s)/data URL)`)
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

/**
 * Write artifacts into `outputDir` (--output), downloading url artifacts so
 * the files outlive the provider's expiring CDN links; base64 decodes as-is.
 */
async function saveArtifacts(artifacts: Artifact[], outputDir: string): Promise<string[]> {
  mkdirSync(outputDir, { recursive: true })
  const saved: string[] = []
  for (const [i, artifact] of artifacts.entries()) {
    let bytes: Buffer | undefined
    if (artifact.base64 !== undefined) {
      bytes = Buffer.from(artifact.base64, "base64")
    } else if (artifact.url !== undefined) {
      const fetched = await fetchArtifactBytes(artifact.url)
      if (fetched.isErr()) {
        warn(`could not download ${artifact.url} (${fetched.error.message}); skipped`)
        continue
      }
      bytes = fetched.value
    } else {
      continue
    }
    const file = `${outputDir}/artifact-${i + 1}.${artifactExtension(artifact)}`
    writeFileSync(file, bytes)
    saved.push(file)
  }
  return saved
}

async function runTextTask(ctx: ExecCtx): Promise<GenerateResult> {
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
  return {
    task: req.task,
    provider: provider.id,
    model,
    capability: "text.generate",
    text: result.text,
    ...(result.usage === undefined ? {} : { usage: result.usage }),
  }
}

async function runUnderstandTask(ctx: ExecCtx): Promise<GenerateResult> {
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
  return {
    task: req.task,
    provider: provider.id,
    model,
    capability: `${kind}.understand`,
    text: result.text,
    ...(result.usage === undefined ? {} : { usage: result.usage }),
  }
}

async function runEmbedTask(ctx: ExecCtx): Promise<GenerateResult> {
  const { req, provider, model, signal } = ctx
  const api = provider.embed
  if (api === undefined) fail(`provider '${provider.id}' implements no embeddings`)
  const result = await api.create(
    { model, inputs: req.inputs ?? [], options: req.options ?? {} },
    { signal },
  )
  return {
    task: req.task,
    provider: provider.id,
    model,
    capability: "embed",
    vectors: result.vectors,
    ...(result.dimensions === undefined ? {} : { dimensions: result.dimensions }),
  }
}

async function runImageTask(
  ctx: ExecCtx,
): Promise<{ artifacts: Artifact[]; usage: Usage | undefined }> {
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

async function runVideoTask(
  ctx: ExecCtx,
): Promise<{ artifacts: Artifact[]; usage: Usage | undefined } | { handle: JobHandle }> {
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
    return { handle }
  }

  const timeoutMs = req.timeout === undefined ? 600_000 : parseDurationMs(req.timeout, "--timeout")
  const intervalMs = req.interval === undefined ? 5000 : parseDurationMs(req.interval, "--interval")

  const startedAt = Date.now()
  const final = await pollUntil((h) => api.poll(h, { signal }), handle, {
    intervalMs,
    timeoutMs,
    signal,
    onStatus: (s) =>
      status(`polling... ${describeStatus(s)} (${Math.round((Date.now() - startedAt) / 1000)}s)`),
  }).catch((e: unknown) => {
    if (signal.aborted || e instanceof JobTimeoutError) {
      throw new CliError(
        "E_TIMEOUT",
        `${(e as Error).message}; task handle: ${JSON.stringify(handle)}`,
        {
          handle,
        },
      )
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
async function executeTask(
  ctx: ExecCtx,
): Promise<
  GenerateResult | { artifacts: Artifact[]; usage: Usage | undefined } | { handle: JobHandle }
> {
  switch (ctx.req.task) {
    case "text2text":
      return runTextTask(ctx)
    case "image2text":
    case "video2text":
      return runUnderstandTask(ctx)
    case "embed":
      return runEmbedTask(ctx)
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
  opts: { configPath?: string | undefined; signal?: AbortSignal | undefined },
): Promise<GenerateResult> {
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

  const signal = opts.signal ?? interruptSignal()

  const timeoutMs = req.timeout === undefined ? 600_000 : parseDurationMs(req.timeout, "--timeout")
  const intervalMs = req.interval === undefined ? 5000 : parseDurationMs(req.interval, "--interval")

  const startedAt = Date.now()
  let final: Awaited<ReturnType<typeof pollUntil>>
  final = await pollUntil((h) => api.poll(h, { signal }), handle, {
    intervalMs,
    timeoutMs,
    signal,
    onStatus: (s) =>
      status(
        `polling... ${s.state}${s.state === "running" && s.progress !== undefined ? ` ${s.progress}%` : ""} (${Math.round((Date.now() - startedAt) / 1000)}s)`,
      ),
  }).catch((e: unknown) => {
    if (signal.aborted || e instanceof JobTimeoutError) {
      throw new CliError(
        "E_TIMEOUT",
        `${(e as Error).message}; task handle: ${JSON.stringify(handle)}`,
        {
          handle,
        },
      )
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
  const savedFiles =
    req.output === undefined ? undefined : await saveArtifacts(final.artifacts, req.output)
  return {
    task: "resume",
    provider: provider.id,
    artifacts: final.artifacts,
    ...(final.usage === undefined ? {} : { usage: final.usage }),
    ...(req.output === undefined ? {} : { outputDir: req.output }),
    ...(savedFiles === undefined || savedFiles.length === 0 ? {} : { savedFiles }),
  }
}

// ---------------------------------------------------------------------------
// Result packaging

/** Provenance spec recorded in a result package: the effective merged request. */
export function effectiveGenSpec(req: GenRequest, providerId: string, model: string): GenSpec {
  const spec: GenSpec = { task: req.task, provider: providerId, model }
  if (req.prompt !== undefined) spec.prompt = req.prompt
  if (req.promptRef !== undefined) spec.promptRef = req.promptRef
  if (req.inputRefs !== undefined && req.inputRefs.length > 0) spec.inputRefs = req.inputRefs
  if (req.system !== undefined) spec.system = req.system
  if (req.images !== undefined && req.images.length > 0) spec.images = req.images
  if (req.firstFrame !== undefined) spec.firstFrame = req.firstFrame
  if (req.lastFrame !== undefined) spec.lastFrame = req.lastFrame
  if (req.inputs !== undefined && req.inputs.length > 0) spec.inputs = req.inputs
  if (req.options !== undefined && Object.keys(req.options).length > 0) spec.options = req.options
  return spec
}

function mediaResultFields(
  req: GenRequest,
  result: { artifacts: Artifact[]; usage: Usage | undefined },
): { capability: Capability; artifacts: Artifact[]; usage?: Usage } {
  const capability: Capability =
    req.task === "text2image" || req.task === "image2image" ? "image.generate" : "video.generate"
  return {
    capability,
    artifacts: result.artifacts,
    ...(result.usage === undefined ? {} : { usage: result.usage }),
  }
}

function mediaResult(
  req: GenRequest,
  providerId: string,
  model: string,
  result: { artifacts: Artifact[]; usage: Usage | undefined },
): GenerateResult {
  return {
    task: req.task,
    provider: providerId,
    model,
    ...mediaResultFields(req, result),
  }
}

/** Everything a generate command can produce; the envelope's `data`. */
export interface GenerateResult {
  task: GenTaskName
  provider?: string
  model?: string
  capability?: Capability
  /** text2text / image2text / video2text output. */
  text?: string
  /** embed output. */
  vectors?: number[][]
  dimensions?: number
  /** --no-wait submit handle. */
  handle?: JobHandle
  artifacts?: Artifact[]
  usage?: Usage
  /** resume --output: files written from base64-only artifacts. */
  savedFiles?: string[]
  outputDir?: string
  tag?: string
  digest?: string
  /** Non-fatal packaging warnings (e.g. a url artifact could not be downloaded). */
  warnings?: string[]
  /** --list-models payload. */
  models?: { entries: ListModelsResult[]; fallback?: ListModelsResult }
}

/** Opt-in OCI packaging for packable text/embed results (--tag/--output). */
async function packageTextResultIfRequested(
  opts: {
    req: GenRequest
    provider: Provider
    model: string
    fromRef?: string
    configPath?: string
  },
  result: GenerateResult,
): Promise<GenerateResult> {
  const { req, provider, model } = opts
  if (req.noPack === true || (req.tag === undefined && req.output === undefined)) return result
  if (TASKS[req.task].packable !== true) return result

  const resultTag = req.tag ?? "gen-output:latest"
  const outputDir = req.output ?? storeDir(envForConfigPath(opts.configPath))
  const pkg = await buildResultPackage({
    outputDir,
    tag: resultTag,
    ...(req.output === undefined ? { store: true } : {}),
    ...(opts.fromRef === undefined ? {} : { fromRef: opts.fromRef }),
    artifacts: [],
    spec: effectiveGenSpec(req, provider.id, model),
    ...(result.text === undefined ? {} : { text: result.text }),
    ...(result.vectors === undefined ? {} : { vectors: result.vectors }),
    ...(result.dimensions === undefined ? {} : { dimensions: result.dimensions }),
    ...(result.usage === undefined ? {} : { usage: result.usage }),
  })
  for (const message of pkg.warnings) warn(message)
  ok(`built ${resultTag} → ${outputDir}`)
  return {
    ...result,
    outputDir,
    tag: resultTag,
    digest: pkg.digest,
    ...(pkg.warnings.length > 0 ? { warnings: pkg.warnings } : {}),
  }
}

// ---------------------------------------------------------------------------
// Rerun fallback: dead input urls → stored bytes

/** The current string value an inputRefs entry points at, if still a url. */
function inputRefTarget(req: GenRequest, ref: InputProvenance): string | undefined {
  switch (ref.field) {
    case "images":
      return ref.index === undefined ? undefined : req.images?.[ref.index]
    case "inputs":
      return ref.index === undefined ? undefined : req.inputs?.[ref.index]
    case "firstFrame":
      return req.firstFrame
    case "lastFrame":
      return req.lastFrame
  }
}

/** Apply a url→localPath replacement map onto a copy of runReq. */
function applyReplacements(runReq: GenRequest, replacements: Map<string, string>): GenRequest {
  const apply = (v: string): string => replacements.get(v) ?? v
  const out: GenRequest = { ...runReq }
  if (runReq.images !== undefined) out.images = runReq.images.map(apply)
  if (runReq.inputs !== undefined) out.inputs = runReq.inputs.map(apply)
  if (runReq.firstFrame !== undefined) out.firstFrame = apply(runReq.firstFrame)
  if (runReq.lastFrame !== undefined) out.lastFrame = apply(runReq.lastFrame)
  return out
}

/** Collect dead-url → temp-file replacements for every anchored input. */
async function collectUrlReplacements(
  refs: InputProvenance[],
  runReq: GenRequest,
  configPath: string | undefined,
  tmp: string,
): Promise<Map<string, string>> {
  const replacements = new Map<string, string>() // dead url → local path
  for (const ref of refs) {
    const target = inputRefTarget(runReq, ref)
    if (target === undefined || !URL_RE.test(target) || replacements.has(target)) continue
    if (ref.digest === undefined) continue
    const stored = await artifactFromStore(ref.digest, target, {
      ...(configPath === undefined ? {} : { configPath }),
    })
    if (stored === undefined) continue
    writeFileSync(join(tmp, stored.name), stored.bytes)
    replacements.set(target, join(tmp, stored.name))
  }
  return replacements
}

/**
 * Replace expiring-url inputs with bytes extracted from the shared store
 * (anchored by gen.inputRefs digests). Returns undefined when no input is
 * replaceable — the caller then surfaces the original provider error.
 */
async function buildInputFallback(
  req: GenRequest,
  runReq: GenRequest,
  configPath: string | undefined,
): Promise<{ req: GenRequest; cleanup: () => void; replaced: number } | undefined> {
  const refs = req.inputRefs ?? []
  if (refs.length === 0) return undefined

  const tmp = mkdtempSync(join(tmpdir(), "creatifact-fallback-"))
  try {
    const replacements = await collectUrlReplacements(refs, runReq, configPath, tmp)
    if (replacements.size === 0) return undefined
    return {
      req: applyReplacements(runReq, replacements),
      cleanup: () => rmSync(tmp, { recursive: true, force: true }),
      replaced: replacements.size,
    }
  } catch {
    rmSync(tmp, { recursive: true, force: true })
    return undefined
  }
}

/**
 * Run a task; on a provider rejection of an input url, retry exactly once
 * with stored bytes per gen.inputRefs. Anything else surfaces as-is.
 */
async function executeWithFallback(
  ctx: ExecCtx,
  req: GenRequest,
  configPath: string | undefined,
): Promise<Awaited<ReturnType<typeof executeTask>>> {
  try {
    return await executeTask(ctx)
  } catch (e) {
    const fallback =
      e instanceof ProviderError ? await buildInputFallback(req, ctx.req, configPath) : undefined
    if (fallback === undefined) throw e
    warn(
      `provider rejected an input url; retrying with stored bytes ` +
        `(${fallback.replaced} input${fallback.replaced === 1 ? "" : "s"}, per gen.inputRefs)`,
    )
    try {
      return await executeTask({ ...ctx, req: fallback.req })
    } finally {
      fallback.cleanup()
    }
  }
}

/** Execute a validated request: run the task and package media results. */
async function executeAndPackage(opts: {
  req: GenRequest
  runReq: GenRequest
  provider: Provider
  model: string
  signal: AbortSignal
  fromRef?: string
  configPath?: string
}): Promise<GenerateResult> {
  const { req, runReq, provider, model, signal } = opts

  const ctx: ExecCtx = { req: runReq, provider, model, signal }
  const result = await executeWithFallback(ctx, req, opts.configPath)
  // Text/understand/embed carry a complete structured payload; packaging
  // stays opt-in (--tag / --output) so stdout-only runs are unchanged.
  if ("task" in result) {
    return await packageTextResultIfRequested(opts, result)
  }
  // --no-wait submit: the handle is the payload.
  if ("handle" in result) {
    return { task: req.task, provider: provider.id, model, handle: result.handle }
  }

  if (req.noPack === true || !TASKS[req.task].media) {
    return mediaResult(req, provider.id, model, result)
  }

  const resultTag = req.tag ?? "gen-output:latest"
  // Default target is the shared store (tag = pointer); --output exports.
  const outputDir = req.output ?? storeDir(envForConfigPath(opts.configPath))
  const pkg = await buildResultPackage({
    outputDir,
    tag: resultTag,
    ...(req.output === undefined ? { store: true } : {}),
    ...(opts.fromRef === undefined ? {} : { fromRef: opts.fromRef }),
    artifacts: result.artifacts,
    spec: effectiveGenSpec(req, provider.id, model),
    usage: result.usage,
  })
  for (const message of pkg.warnings) warn(message)
  ok(`built ${resultTag} → ${outputDir}`)
  return {
    ...mediaResult(req, provider.id, model, result),
    outputDir,
    tag: resultTag,
    digest: pkg.digest,
    ...(pkg.warnings.length > 0 ? { warnings: pkg.warnings } : {}),
  }
}

/** Run a request built programmatically (CLI args, `-f` files, callers). */
export async function runGenerateRequest(
  req: GenRequest,
  opts: GenerateRunOptions = {},
): Promise<GenerateResult> {
  validateRequest(req)
  if (req.task === "resume") return runResumeTask(req, opts)
  rejectPkgRefsOutsidePackageMode(req)
  const { provider, model } = await resolveProviderForTask(req, opts)
  return executeAndPackage({
    req,
    runReq: req,
    provider,
    model,
    signal: opts.signal ?? interruptSignal(),
    ...(opts.configPath === undefined ? {} : { configPath: opts.configPath }),
  })
}

// ---------------------------------------------------------------------------
// Package (recipe) mode

/** Sync set of tags in the shared store, for ref-vs-task routing (empty on any error). */
function storeTagSet(configPath?: string): Set<string> {
  try {
    const index = JSON.parse(
      readFileSync(join(storeDir(envForConfigPath(configPath)), "index.json"), "utf8"),
    ) as { manifests?: Array<{ annotations?: Record<string, string> }> }
    return new Set(
      (index.manifests ?? [])
        .map((m) => m.annotations?.["org.opencontainers.image.ref.name"])
        .filter((r): r is string => r !== undefined),
    )
  } catch {
    return new Set()
  }
}

/** True when the first positional is a package ref rather than a task. */
function looksLikeGenRef(arg: string, storeTags?: Set<string>): boolean {
  if (isLocalRef(arg)) return true
  if (storeTags?.has(arg)) return true
  return looksLikeRegistryRef(arg)
}

/**
 * Materialize pkg:// references (images / frames / inputs into temp files,
 * prompt read inline as utf8) from the package layers. Non-pkg values pass
 * through untouched.
 */
async function materializePackageMedia(
  req: GenRequest,
  image: LoadedImage,
): Promise<{ req: GenRequest; cleanup: () => void }> {
  const usesPkg =
    req.prompt?.startsWith("pkg://") === true ||
    (req.images ?? []).some((v) => v.startsWith("pkg://")) ||
    (req.firstFrame?.startsWith("pkg://") ?? false) ||
    (req.lastFrame?.startsWith("pkg://") ?? false) ||
    (req.inputs ?? []).some((v) => v.startsWith("pkg://"))
  if (!usesPkg) return { req, cleanup: () => {} }

  const view = await packageFsView(image)
  const tmp = mkdtempSync(join(tmpdir(), "creatifact-pkgref-"))
  const lookup = (value: string): { type: "file"; data: Buffer } => {
    const rel = value.slice("pkg://".length)
    const entry = view.get(rel)
    if (entry === undefined || entry.type !== "file") {
      fail(`package media ref '${value}': '${rel}' not found in the package layers`)
    }
    return entry
  }
  const extract = (value: string | undefined): string | undefined => {
    if (value === undefined || !value.startsWith("pkg://")) return value
    const entry = lookup(value)
    const base = value.slice("pkg://".length).split("/").pop() ?? "file"
    const out = join(tmp, base)
    writeFileSync(out, entry.data)
    return out
  }
  // A prompt that is exactly one pkg:// ref is replaced by the file's text —
  // long instructions ship as layer files instead of giant JSON strings.
  const prompt =
    req.prompt?.startsWith("pkg://") === true
      ? lookup(req.prompt).data.toString("utf8")
      : req.prompt

  const images = req.images?.map((v) => extract(v) ?? v)
  const firstFrame = extract(req.firstFrame)
  const lastFrame = extract(req.lastFrame)
  const inputs = req.inputs?.map((v) => extract(v) ?? v)

  return {
    req: {
      ...req,
      ...(prompt !== undefined ? { prompt } : {}),
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
  opts: { configPath?: string | undefined; signal?: AbortSignal | undefined } = {},
): Promise<GenerateResult> {
  const plainHttp = options.plainHttp === true

  const image = await loadGenImage(ref, { plainHttp, configPath: opts.configPath }, fetchImage)
  if (image.manifest.config.mediaType !== GEN_CONFIG_MEDIA_TYPE) {
    fail(
      `${ref}: not a gen package (config mediaType ${image.manifest.config.mediaType}); ` +
        "build one by adding a 'gen' field to creatifact.json",
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
    return await executeAndPackage({
      req,
      runReq,
      provider,
      model,
      signal: opts.signal ?? interruptSignal(),
      fromRef: ref,
      ...(opts.configPath === undefined ? {} : { configPath: opts.configPath }),
    })
  } finally {
    cleanup()
  }
}

// ---------------------------------------------------------------------------
// Entry point

/** pkg:// references only resolve inside package mode. */
function rejectPkgRefsOutsidePackageMode(req: GenRequest): void {
  const fields = [
    ...(req.prompt?.startsWith("pkg://") === true ? [req.prompt] : []),
    ...(req.images ?? []),
    ...(req.inputs ?? []),
    ...(req.firstFrame !== undefined ? [req.firstFrame] : []),
    ...(req.lastFrame !== undefined ? [req.lastFrame] : []),
  ]
  if (fields.some((v) => v.startsWith("pkg://"))) {
    fail("`pkg://` references only work with `creatifact generate <ref>` (a gen package)")
  }
}

export interface GenerateRunOptions {
  configPath?: string | undefined
  /** Cancellation for the whole run; defaults to the process interrupt signal. */
  signal?: AbortSignal | undefined
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
    addTaskOptions(cmd, task)
    addTaskArguments(cmd, task)
    addGlobalOptions(cmd)
    // Arguments are declared dynamically, so read positionals from command.args
    // instead of the action callback's positional parameters.
    cmd.action(async (...invocation: unknown[]) => {
      const command = invocation.at(-1) as Command
      const options = (invocation.at(-2) ?? {}) as GenerateCommandOptions
      const args = command.args
      const opts = configOpts(command, options.configDir)
      if (options.listModels === true) {
        const result = await runListModels(task, args, options, opts)
        emitResult("generate", result, prettyOpts(command))
        return
      }
      const overlay = overlayFromParsed(task, args, options, providerContext(opts), {})
      const result = await runGenerateRequest(mergeRequest({ task }, overlay), opts)
      emitResult("generate", result, prettyOpts(command))
    })
  }

  gen.action(async (options: { configDir?: string }, command: Command) => {
    const args = command.args
    if (args.length === 0) {
      command.help()
      return
    }
    const head = args[0] as string
    const storeTags = storeTagSet(configOpts(command, options.configDir).configPath)
    if (looksLikeGenRef(head, storeTags)) {
      // The trailing operands include the task flags; parse them here.
      const { options: taskOpts, positionals } = parseArgsWith<GenerateCommandOptions>(
        buildRefTaskCommand(),
        args.slice(1),
      )
      const result = await runGeneratePackage(
        head,
        positionals,
        taskOpts,
        configOpts(command, taskOpts.configDir, options.configDir),
      )
      emitResult("generate", result, prettyOpts(command))
      return
    }
    fail(`unknown generate task '${head}' (expected ${TASK_LIST}, or a gen package ref)`)
  })

  return gen
}
