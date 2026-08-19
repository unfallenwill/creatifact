import type { Capability, ModelSupport } from "./providers"

/**
 * Task-oriented generation. Every task is an X2Y name; the task registry is
 * the single source of truth for parameters (required/optional/forbidden),
 * default-model selection, CLI usage, and the JSON request fields. CLI args,
 * `-f` JSON files, and recipe packages all normalize to one GenRequest, with
 * CLI flags taking priority.
 */

export type GenTaskName =
  | "text2text"
  | "image2text"
  | "video2text"
  | "text2image"
  | "image2image"
  | "text2video"
  | "image2video"
  | "frames2video"
  | "embed"
  | "resume"

export interface TaskSpec {
  name: GenTaskName
  /** undefined for the control command `resume`. */
  capability: Capability | undefined
  /** Produces media artifacts → result packaging applies. */
  media: boolean
  /** Field requirements; absent optional fields below are forbidden. */
  required: {
    prompt?: boolean
    images?: 1
    firstFrame?: boolean
    lastFrame?: boolean
    inputs?: boolean
    handle?: boolean
  }
  optional: {
    system?: boolean
    prompt?: boolean
    options?: boolean
    noWait?: boolean
    timeout?: boolean
    interval?: boolean
  }
  /** Positional payload after the optional provider. */
  payload: "prompt" | "inputs" | "handle"
  /** Strict default-model filter over the capability's ModelSupport. */
  pickModel?: (s: ModelSupport) => boolean
  /** Hard-fail when no model passes pickModel (frames2video). */
  strictModel?: boolean
}

/**
 * Does this model verifiably support the task? Mirrors the `satisfies`
 * predicate inside pickModelForTask: has the task's capability AND passes the
 * task's pickModel filter (when the task has one). This is the single
 * derivation every discoverability surface (models listing, --list-models,
 * error suggestions) must share, so a listed model is always a runnable one.
 */
export function modelSupportsTask(
  model: { capabilities: Partial<Record<Capability, ModelSupport>> },
  task: GenTaskName,
): boolean {
  const spec = TASKS[task]
  const cap = spec.capability
  if (cap === undefined) return false
  const support = model.capabilities[cap]
  if (support === undefined) return false
  return spec.pickModel === undefined || spec.pickModel(support)
}

/** The tasks a model verifiably supports, in TASKS declaration order. */
export function tasksForModel(model: {
  capabilities: Partial<Record<Capability, ModelSupport>>
}): GenTaskName[] {
  return (Object.keys(TASKS) as GenTaskName[]).filter((task) => modelSupportsTask(model, task))
}

export const TASKS: Record<GenTaskName, TaskSpec> = {
  text2text: {
    name: "text2text",
    capability: "text.generate",
    media: false,
    required: { prompt: true },
    optional: { system: true, options: true },
    payload: "prompt",
  },
  image2text: {
    name: "image2text",
    capability: "image.understand",
    media: false,
    required: { inputs: true },
    optional: { prompt: true, options: true },
    payload: "prompt",
  },
  video2text: {
    name: "video2text",
    capability: "video.understand",
    media: false,
    required: { inputs: true },
    optional: { prompt: true, options: true },
    payload: "prompt",
  },
  text2image: {
    name: "text2image",
    capability: "image.generate",
    media: true,
    required: { prompt: true },
    optional: { options: true },
    payload: "prompt",
  },
  image2image: {
    name: "image2image",
    capability: "image.generate",
    media: true,
    required: { prompt: true, images: 1 },
    optional: { options: true },
    payload: "prompt",
    pickModel: (s) => s.imageInput === true,
  },
  text2video: {
    name: "text2video",
    capability: "video.generate",
    media: true,
    required: { prompt: true },
    optional: { options: true, noWait: true, timeout: true, interval: true },
    payload: "prompt",
    pickModel: (s) => s.textOnly !== false,
  },
  image2video: {
    name: "image2video",
    capability: "video.generate",
    media: true,
    required: { prompt: true, images: 1 },
    optional: { options: true, noWait: true, timeout: true, interval: true },
    payload: "prompt",
    pickModel: (s) => s.firstFrame === true,
  },
  frames2video: {
    name: "frames2video",
    capability: "video.generate",
    media: true,
    required: { prompt: true, firstFrame: true, lastFrame: true },
    optional: { options: true, noWait: true, timeout: true, interval: true },
    payload: "prompt",
    pickModel: (s) => s.firstFrame === true && s.lastFrame === true,
    strictModel: true,
  },
  embed: {
    name: "embed",
    capability: "embed",
    media: false,
    required: { inputs: true },
    optional: { options: true },
    payload: "inputs",
  },
  resume: {
    name: "resume",
    capability: undefined,
    media: false,
    required: { handle: true },
    optional: { timeout: true, interval: true },
    payload: "handle",
  },
}

/** JSON request field names a task accepts (for `-f` files and the schema). */
export function requestFieldsForTask(task: GenTaskName): Set<string> {
  const spec = TASKS[task]
  const fields = new Set<string>(["provider", "model", "json"])
  if (spec.required.prompt || spec.optional.prompt) fields.add("prompt")
  if (spec.optional.system === true) fields.add("system")
  if (spec.required.images !== undefined) fields.add("images")
  if (spec.required.firstFrame === true) fields.add("firstFrame")
  if (spec.required.lastFrame === true) fields.add("lastFrame")
  if (spec.required.inputs === true) fields.add("inputs")
  if (spec.optional.options === true) fields.add("options")
  if (spec.optional.noWait === true) fields.add("noWait")
  if (spec.optional.timeout === true) fields.add("timeout")
  if (spec.optional.interval === true) fields.add("interval")
  if (spec.media || task === "resume") fields.add("output")
  if (spec.media) {
    fields.add("tag")
    fields.add("noPack")
  }
  if (task === "resume") fields.add("handle")
  return fields
}
