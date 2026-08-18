import type { CommandResult } from "./execute"
import { executeCommand } from "./execute"
import { commandRequestFromFields, type Fields } from "./requestFile"

/** One pipeline step: a request-file command plus an optional reference name. */
export interface PipelineStep {
  name?: string
  command: string
  fields: Fields
}

export interface PipelineRunOptions {
  configPath?: string
  signal?: AbortSignal
}

const PLACEHOLDER_RE =
  /\$\{([a-zA-Z][a-zA-Z0-9_]*)\.([a-zA-Z][a-zA-Z0-9_]*)(?:\[([0-9]+)\]\.([a-zA-Z][a-zA-Z0-9_]*))?\}/g

/** Fields of each CommandResult that steps may reference. */
function referencableFields(result: CommandResult): string[] {
  switch (result.kind) {
    case "build":
      return ["tag", "digest", "outputDir"]
    case "push":
      return ["tag", "digest"]
    case "pull":
      return ["outputDir", "digest"]
    case "generate":
      return ["tag", "digest", "outputDir", "artifacts[N].url", "artifacts[N].base64"]
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

/**
 * Fail fast on structural problems before any step runs: duplicate names,
 * unknown / forward / void references, and generate steps that would pollute
 * the pipeline (noWait prints a handle and returns nothing; json fights the
 * pipeline's own output).
 */
function precheck(steps: PipelineStep[]): void {
  if (steps.length === 0) throw new Error("steps must be a non-empty array")
  const seen = new Map<string, number>()
  for (const [i, step] of steps.entries()) {
    if (step.name === undefined) continue
    if (seen.has(step.name)) {
      throw new Error(`duplicate step name '${step.name}' (steps ${seen.get(step.name)} and ${i})`)
    }
    seen.set(step.name, i)
  }
  for (const [i, step] of steps.entries()) {
    if (step.command.startsWith("generate.")) {
      if (step.fields["noWait"] === true) {
        throw new Error(`step ${i}: generate steps cannot use noWait inside a pipeline`)
      }
      if (step.fields["json"] === true) {
        throw new Error(`step ${i}: generate steps cannot use json inside a pipeline`)
      }
    }
    const refs: { text: string; ref: ParsedRef }[] = []
    collectRefs(step.fields, refs)
    for (const { ref } of refs) {
      const target = seen.get(ref.step)
      if (target === undefined) {
        throw new Error(
          `step ${i} references unknown step '${ref.step}' (known: ${[...seen.keys()].join(", ") || "none"})`,
        )
      }
      if (target >= i) {
        throw new Error(
          `step ${i} references '${refLabel(ref)}' which runs later (forward reference)`,
        )
      }
    }
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
      `\${${whole.step}.${whole.field}${whole.index === undefined ? "" : `[${whole.index}].${whole.prop}`}` ===
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

function refValue(ref: ParsedRef, results: Map<string, CommandResult>, stepIndex: number): unknown {
  const result = results.get(ref.step)
  if (result === undefined) {
    throw new Error(`step ${stepIndex}: no result for '${ref.step}'`)
  }
  const allowed = referencableFields(result)
  if (result.kind === "void") {
    throw new Error(
      `step ${stepIndex}: '${ref.step}' produced no referenceable output (void result); referenceable steps return tag/digest/outputDir/artifacts`,
    )
  }
  if (ref.index !== undefined) {
    if (
      ref.field !== "artifacts" ||
      ref.prop === undefined ||
      (ref.prop !== "url" && ref.prop !== "base64")
    ) {
      throw new Error(
        `step ${stepIndex}: '${refLabel(ref)}' is not referenceable (allowed for this step: ${allowed.join(", ")})`,
      )
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
  const value = resolveResultField(result, ref.field)
  if (value === undefined || !allowed.includes(ref.field)) {
    throw new Error(
      `step ${stepIndex}: '${refLabel(ref)}' is not referenceable (allowed for this step: ${allowed.join(", ")})`,
    )
  }
  return value
}

/**
 * Run request-file steps sequentially: fail fast, register each named step's
 * CommandResult, and resolve `${step.field}` placeholders (including
 * `artifacts[N].url`) before each step runs. Media steps (build / generate)
 * without an explicit output write to `oci-layout-step-<n>` so they never
 * collide inside one pipeline.
 */
export async function runPipeline(
  steps: PipelineStep[],
  opts: PipelineRunOptions = {},
): Promise<Map<string, CommandResult>> {
  precheck(steps)
  const results = new Map<string, CommandResult>()

  for (const [i, step] of steps.entries()) {
    if (opts.signal?.aborted) {
      throw new Error(`pipeline aborted before step ${i + 1}/${steps.length}`)
    }
    const label = step.name ?? `step-${i + 1}`
    console.error(`[${i + 1}/${steps.length}] ${label} · ${step.command}`)

    const fields = resolvePlaceholders(step.fields, results, i) as Fields
    const request = commandRequestFromFields(step.command, fields)
    if (
      (request.kind === "build" || request.kind === "generate") &&
      request.req.output === undefined
    ) {
      request.req.output = `oci-layout-step-${i + 1}`
    }

    try {
      const result = await executeCommand(request, { configPath: opts.configPath })
      if (step.name !== undefined) results.set(step.name, result)
    } catch (e) {
      throw new Error(
        `step '${label}' (${i + 1}/${steps.length}) failed: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }

  return results
}
