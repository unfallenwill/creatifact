import { REFERENCEABLE } from "./contract"
import { CliError, usageError } from "./errors"
import type { CommandResult } from "./execute"
import { executeCommand } from "./execute"
import { status } from "./format"
import type { InputProvenance, StepProvenance } from "./genPackage"
import { commandRequestFromFields, type Fields } from "./requestFile"

/** One pipeline step: a request-file command plus an optional reference name. */
export interface PipelineStep {
  name?: string
  command: string
  fields: Fields
}

export interface PipelineRunOptions {
  configPath?: string | undefined
  signal?: AbortSignal | undefined
}

const PLACEHOLDER_RE =
  /\$\{([a-zA-Z][a-zA-Z0-9_]*)\.([a-zA-Z][a-zA-Z0-9_]*)(?:\[([0-9]+)\]\.([a-zA-Z][a-zA-Z0-9_]*))?\}/g

/** Fields of each CommandResult that steps may reference (presence-filtered). */
function referencableFields(result: CommandResult): string[] {
  switch (result.kind) {
    case "build":
      return [...REFERENCEABLE.build]
    case "push":
      return [...REFERENCEABLE.push]
    case "pull":
      return [...REFERENCEABLE.pull]
    case "generate": {
      // Structured payloads are referenceable when present: a text2text step
      // exposes `${writer.text}`, embed exposes `${e.vectors}` — so a
      // text2image / image2video step can chain on a generated prompt.
      // The field list lives in contract.ts (compile-time locked to the
      // result types); here we only presence-filter at runtime.
      const scalar: string[] = REFERENCEABLE.generate.filter(
        (field) => (result as unknown as Record<string, unknown>)[field] !== undefined,
      )
      if (result.artifacts !== undefined) scalar.push("artifacts[N].url", "artifacts[N].base64")
      return scalar
    }
    default:
      return []
  }
}

function resolveResultField(result: CommandResult, field: string): unknown {
  if (field === "artifacts") return result.kind === "generate" ? result.artifacts : undefined
  if (
    result.kind === "build" ||
    result.kind === "push" ||
    result.kind === "pull" ||
    result.kind === "generate"
  ) {
    const value = (result as unknown as Record<string, unknown>)[field]
    return value
  }
  return undefined
}

interface ParsedRef {
  step: string
  field: string
  index: number | undefined
  prop: string | undefined
}

function parseRef(text: string): ParsedRef | undefined {
  PLACEHOLDER_RE.lastIndex = 0
  const m = PLACEHOLDER_RE.exec(text)
  if (m === null) return undefined
  return {
    step: m[1] as string,
    field: m[2] as string,
    index: m[3] === undefined ? undefined : Number(m[3]),
    prop: m[4],
  }
}

/** Collect every `${step.field}` reference inside a step's field values. */
function collectRefs(value: unknown, out: { text: string; ref: ParsedRef }[]): void {
  if (typeof value === "string") {
    const ref = parseRef(value)
    if (ref !== undefined) out.push({ text: value, ref })
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, out)
    return
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectRefs(item, out)
  }
}

function refLabel(ref: ParsedRef): string {
  return ref.index === undefined
    ? `${ref.step}.${ref.field}`
    : `${ref.step}.${ref.field}[${ref.index}].${ref.prop}`
}

function collectStepNames(steps: PipelineStep[]): Map<string, number> {
  const seen = new Map<string, number>()
  for (const [i, step] of steps.entries()) {
    if (step.name === undefined) continue
    if (seen.has(step.name)) {
      throw usageError(`duplicate step name '${step.name}' (steps ${seen.get(step.name)} and ${i})`)
    }
    seen.set(step.name, i)
  }
  return seen
}

function validateGenerateStep(step: PipelineStep, stepIndex: number): void {
  if (!step.command.startsWith("generate.")) return
  if (step.fields["noWait"] === true) {
    throw usageError(`step ${stepIndex}: generate steps cannot use noWait inside a pipeline`)
  }
}

function validateStepReferences(
  step: PipelineStep,
  stepIndex: number,
  seen: Map<string, number>,
): void {
  const refs: { text: string; ref: ParsedRef }[] = []
  collectRefs(step.fields, refs)
  for (const { ref } of refs) {
    const target = seen.get(ref.step)
    if (target === undefined) {
      throw usageError(
        `step ${stepIndex} references unknown step '${ref.step}' (known: ${[...seen.keys()].join(", ") || "none"})`,
      )
    }
    if (target >= stepIndex) {
      throw usageError(
        `step ${stepIndex} references '${refLabel(ref)}' which runs later (forward reference)`,
      )
    }
  }
}

/**
 * Fail fast on structural problems before any step runs: duplicate names,
 * unknown / forward / void references, and generate steps that would pollute
 * the pipeline (noWait prints a handle and returns nothing; json fights the
 * pipeline's own output).
 */
function precheck(steps: PipelineStep[]): void {
  if (steps.length === 0) throw usageError("steps must be a non-empty array")
  const seen = collectStepNames(steps)
  for (const [i, step] of steps.entries()) {
    validateGenerateStep(step, i)
    validateStepReferences(step, i, seen)
  }
}

/** Substitute `${step.field}` placeholders in a step's fields with results. */
function resolvePlaceholders(
  value: unknown,
  results: Map<string, CommandResult>,
  stepIndex: number,
): unknown {
  if (typeof value === "string") {
    const whole = parseRef(value)
    if (
      whole !== null &&
      whole !== undefined &&
      `\${${whole.step}.${whole.field}${whole.index === undefined ? "" : `[${whole.index}].${whole.prop}`}}` ===
        value
    ) {
      return refValue(whole, results, stepIndex)
    }
    return value.replace(PLACEHOLDER_RE, (_match, ...groups) => {
      const ref: ParsedRef = {
        step: groups[0] as string,
        field: groups[1] as string,
        index: groups[2] === undefined ? undefined : Number(groups[2]),
        prop: groups[3],
      }
      const resolved = refValue(ref, results, stepIndex)
      return typeof resolved === "string" ? resolved : String(resolved)
    })
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolvePlaceholders(item, results, stepIndex))
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = resolvePlaceholders(v, results, stepIndex)
    return out
  }
  return value
}

function notReferenceableError(ref: ParsedRef, allowed: string[], stepIndex: number): Error {
  return usageError(
    `step ${stepIndex}: '${refLabel(ref)}' is not referenceable (allowed for this step: ${allowed.join(", ")})`,
  )
}

function isReferenceableArtifactRef(
  ref: ParsedRef & { index: number },
): ref is ParsedRef & { field: "artifacts"; index: number; prop: "url" | "base64" } {
  return ref.field === "artifacts" && (ref.prop === "url" || ref.prop === "base64")
}

function artifactRefValue(
  ref: ParsedRef & { index: number },
  result: CommandResult,
  allowed: string[],
  stepIndex: number,
): unknown {
  if (!isReferenceableArtifactRef(ref)) {
    throw notReferenceableError(ref, allowed, stepIndex)
  }
  const artifacts = result.kind === "generate" ? result.artifacts : undefined
  const artifact = artifacts?.[ref.index]
  if (artifact === undefined) {
    throw new Error(
      `step ${stepIndex}: '${ref.step}' has no artifact at index ${ref.index} (got ${artifacts?.length ?? 0})`,
    )
  }
  const value = ref.prop === "url" ? artifact.url : artifact.base64
  if (value === undefined) {
    throw new Error(`step ${stepIndex}: '${refLabel(ref)}' has no ${ref.prop}`)
  }
  return value
}

function resultFieldRefValue(
  ref: ParsedRef,
  result: CommandResult,
  allowed: string[],
  stepIndex: number,
): unknown {
  const value = resolveResultField(result, ref.field)
  if (value === undefined || !allowed.includes(ref.field)) {
    throw notReferenceableError(ref, allowed, stepIndex)
  }
  return value
}

function refValue(ref: ParsedRef, results: Map<string, CommandResult>, stepIndex: number): unknown {
  const result = results.get(ref.step)
  if (result === undefined) {
    throw usageError(`step ${stepIndex}: no result for '${ref.step}'`)
  }
  const allowed = referencableFields(result)
  return ref.index === undefined
    ? resultFieldRefValue(ref, result, allowed, stepIndex)
    : artifactRefValue(ref as ParsedRef & { index: number }, result, allowed, stepIndex)
}

/** One executed pipeline step and its result, for the summary envelope. */
export interface PipelineStepOutcome {
  name?: string | undefined
  command: string
  result: CommandResult
}

/** The pipeline run's outcome: ordered step results plus named lookups. */
export interface PipelineRunResult {
  steps: PipelineStepOutcome[]
  results: Map<string, CommandResult>
}

/**
 * Run request-file steps sequentially: fail fast, register each named step's
 * CommandResult, and resolve `${step.field}` placeholders (including
 * `artifacts[N].url`) before each step runs. Media steps (build / generate)
 * without an explicit output write into the shared store under their own tag,
 * so `${s1.outputDir}` (the store) and `${s1.tag}` stay referenceable and
 * reruns replace the same tag instead of colliding with stale output.
 */
export async function runPipeline(
  steps: PipelineStep[],
  opts: PipelineRunOptions = {},
): Promise<PipelineRunResult> {
  precheck(steps)
  const results = new Map<string, CommandResult>()
  const outcomes: PipelineStepOutcome[] = []

  for (const [i, step] of steps.entries()) {
    if (opts.signal?.aborted) {
      throw new Error(`pipeline aborted before step ${i + 1}/${steps.length}`)
    }
    const label = step.name ?? `step-${i + 1}`
    status(`[${i + 1}/${steps.length}] ${label} · ${step.command}`)
    outcomes.push(await runStep(step, label, i, steps.length, results, opts))
  }

  return { steps: outcomes, results }
}

/** True when the string is exactly one reference (no interpolation around it). */
function wholeRef(value: string): ParsedRef | undefined {
  const ref = parseRef(value)
  if (ref === undefined) return undefined
  const canon = `\${${ref.step}.${ref.field}${ref.index === undefined ? "" : `[${ref.index}].${ref.prop}`}}`
  return canon === value ? ref : undefined
}

/** Provenance anchors (digest/tag) for a referenced generate step, when packed. */
function anchorsOf(result: CommandResult & { kind: "generate" }): {
  digest?: string
  tag?: string
} {
  const out: { digest?: string; tag?: string } = {}
  if (typeof result.digest === "string") out.digest = result.digest
  if (typeof result.tag === "string") out.tag = result.tag
  return out
}

/**
 * Detect "this step's prompt is exactly one earlier step's output" and
 * attach a digest-anchored provenance pointer. Only fires when the referenced
 * step actually packed its result (digest present); otherwise the prompt's
 * textual value alone is recorded, as before.
 */
function promptProvenance(
  step: PipelineStep,
  results: Map<string, CommandResult>,
): StepProvenance | undefined {
  if (!step.command.startsWith("generate.")) return undefined
  const prompt = step.fields["prompt"]
  if (typeof prompt !== "string") return undefined
  const ref = wholeRef(prompt)
  if (ref === undefined || ref.index !== undefined) return undefined
  const result = results.get(ref.step)
  if (result?.kind !== "generate") return undefined
  const value = (result as unknown as Record<string, unknown>)[ref.field]
  if (typeof value !== "string") return undefined
  return { name: ref.step, ...anchorsOf(result) }
}

const MEDIA_INPUT_FIELDS = ["images", "firstFrame", "lastFrame", "inputs"] as const

/** Provenance for one media-entry candidate, when it is a whole step artifact ref. */
function entryProvenance(
  field: (typeof MEDIA_INPUT_FIELDS)[number],
  index: number | undefined,
  entry: unknown,
  results: Map<string, CommandResult>,
): InputProvenance | undefined {
  if (typeof entry !== "string") return undefined
  const ref = wholeRef(entry)
  if (ref === undefined || ref.index === undefined) return undefined
  const result = results.get(ref.step)
  if (result?.kind !== "generate" || result.artifacts === undefined) return undefined
  return {
    field,
    ...(index === undefined ? {} : { index }),
    name: ref.step,
    ...anchorsOf(result),
  }
}

/**
 * Detect media-input entries that are exactly one earlier step's artifact
 * reference (`${step.artifacts[N].url}`) and record digest-anchored pointers:
 * the URL sent to the provider expires, the source package's bytes do not.
 */
function inputProvenance(
  step: PipelineStep,
  results: Map<string, CommandResult>,
): InputProvenance[] | undefined {
  if (!step.command.startsWith("generate.")) return undefined
  const out: InputProvenance[] = []
  for (const field of MEDIA_INPUT_FIELDS) {
    const value = step.fields[field]
    if (value === undefined) continue
    const isArray = Array.isArray(value)
    const entries: unknown[] = isArray ? value : [value]
    for (const [index, entry] of entries.entries()) {
      const provenance = entryProvenance(field, isArray ? index : undefined, entry, results)
      if (provenance !== undefined) out.push(provenance)
    }
  }
  return out.length > 0 ? out : undefined
}

/** Execute one pipeline step, registering its result for later references. */
async function runStep(
  step: PipelineStep,
  label: string,
  i: number,
  total: number,
  results: Map<string, CommandResult>,
  opts: PipelineRunOptions,
): Promise<PipelineStepOutcome> {
  const fields = resolvePlaceholders(step.fields, results, i) as Fields
  const request = commandRequestFromFields(step.command, fields)
  const provenance = promptProvenance(step, results)
  const inputRefs = inputProvenance(step, results)
  if (request.kind === "generate") {
    if (provenance !== undefined) request.req.promptRef = provenance
    if (inputRefs !== undefined) request.req.inputRefs = inputRefs
  }

  try {
    const result = await executeCommand(request, {
      configPath: opts.configPath,
      signal: opts.signal,
    })
    if (step.name !== undefined) results.set(step.name, result)
    return {
      command: step.command,
      ...(step.name === undefined ? {} : { name: step.name }),
      result,
    }
  } catch (e) {
    // Keep the inner error's classification (usage/config/provider/...)
    // while adding the step context agents need to locate the failure.
    const message = `step '${label}' (${i + 1}/${total}) failed: ${e instanceof Error ? e.message : String(e)}`
    if (e instanceof CliError) throw new CliError(e.code, message, e.details)
    throw new Error(message)
  }
}
