import type { ModelDeclaration } from "../../config"
import type { Capability, ModelSupport, VerifiedModel } from "./types"

export type { ModelDeclaration }

/**
 * The model registry merge layer: user model declarations from
 * config.json's `models.<providerId>` section are merged into a provider's
 * built-in verified list. The protocol layer stays code — a declaration can
 * only reference modes the provider already implements.
 *
 * Merge semantics (SmartMerge): entries whose id exists in the built-in list
 * override it (shallow: given fields win); unknown ids are appended and
 * marked `source: "custom"`.
 */

export interface MergedModels {
  models: VerifiedModel[]
  /** Validated `mode` per declared model id (custom + overridden). */
  modeFor: Record<string, string>
}

function fail(providerId: string, message: string): never {
  throw new Error(`models config for '${providerId}': ${message}`)
}

/** Parse & type-check one raw declaration entry; throws via fail(). */
function parseDeclaration(providerId: string, raw: unknown, index: number): ModelDeclaration {
  if (typeof raw !== "object" || raw === null) {
    fail(providerId, `entry [${index}] must be an object`)
  }
  const decl = raw as ModelDeclaration
  if (typeof decl.id !== "string" || decl.id === "") {
    fail(providerId, `entry [${index}].id must be a non-empty string`)
  }
  if (decl.note !== undefined && typeof decl.note !== "string") {
    fail(providerId, `entry [${index}] (${decl.id}): note must be a string`)
  }
  validateCapabilities(providerId, decl, index)
  return decl
}

function validateCapabilities(providerId: string, decl: ModelDeclaration, index: number): void {
  if (decl.capabilities === undefined) return
  if (typeof decl.capabilities !== "object" || decl.capabilities === null) {
    fail(providerId, `entry [${index}] (${decl.id}): capabilities must be an object`)
  }
  for (const [cap, support] of Object.entries(decl.capabilities)) {
    if (typeof support !== "object" || support === null) {
      fail(providerId, `${decl.id}: capabilities.${cap} must be an object`)
    }
  }
}

/** Validate the mode field against the provider's mode table. */
function validateMode(
  providerId: string,
  decl: ModelDeclaration,
  isKnownId: boolean,
  knownModes: readonly string[] | undefined,
): string | undefined {
  if (decl.mode === undefined) {
    if (
      knownModes !== undefined &&
      decl.capabilities?.["video.generate"] !== undefined &&
      !isKnownId
    ) {
      fail(
        providerId,
        `${decl.id}: declares video.generate, so 'mode' is required (one of: ${knownModes.join(", ")})`,
      )
    }
    return undefined
  }
  if (typeof decl.mode !== "string" || decl.mode === "") {
    fail(providerId, `${decl.id}: mode must be a non-empty string`)
  }
  if (knownModes === undefined) {
    fail(providerId, `${decl.id}: provider has no protocol modes; remove 'mode'`)
  }
  if (!knownModes.includes(decl.mode)) {
    fail(providerId, `${decl.id}: unknown mode '${decl.mode}' (valid: ${knownModes.join(", ")})`)
  }
  return decl.mode
}

/** Merge one declaration into the ordered list (append custom / override builtin). */
function applyDeclaration(
  byId: Map<string, VerifiedModel>,
  order: VerifiedModel[],
  decl: ModelDeclaration,
): void {
  const existing = byId.get(decl.id)
  if (existing === undefined) {
    const appended: VerifiedModel = {
      id: decl.id,
      capabilities: (decl.capabilities ?? {}) as Partial<Record<Capability, ModelSupport>>,
      source: "custom",
      ...(decl.note === undefined ? {} : { note: decl.note }),
    }
    byId.set(decl.id, appended)
    order.push(appended)
    return
  }
  const merged: VerifiedModel = {
    ...existing,
    ...(decl.note === undefined ? {} : { note: decl.note }),
    ...(decl.capabilities === undefined
      ? {}
      : {
          capabilities: {
            ...existing.capabilities,
            ...(decl.capabilities as Partial<Record<Capability, ModelSupport>>),
          },
        }),
  }
  byId.set(decl.id, merged)
  order[order.findIndex((m) => m.id === decl.id)] = merged
}

export function mergeModelDeclarations(
  providerId: string,
  builtin: VerifiedModel[],
  declarations: unknown,
  knownModes?: readonly string[],
): MergedModels {
  const modeFor: Record<string, string> = {}
  if (declarations === undefined) return { models: builtin, modeFor }
  if (!Array.isArray(declarations)) {
    fail(providerId, "must be an array of model entries")
  }

  const byId = new Map(builtin.map((m) => [m.id, m]))
  const order = [...builtin]

  for (const [index, raw] of (declarations as unknown[]).entries()) {
    const decl = parseDeclaration(providerId, raw, index)
    const mode = validateMode(providerId, decl, byId.has(decl.id), knownModes)
    if (mode !== undefined) modeFor[decl.id] = mode
    applyDeclaration(byId, order, decl)
  }

  return { models: order, modeFor }
}

const ENV_REF_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/

/**
 * Expand whole-value `${VAR}` references in string fields of a settings
 * object against env. An unresolvable reference resolves to undefined so the
 * provider's own missing-credential error fires (the literal never reaches
 * the API); the config file on disk is never rewritten with expanded values.
 */
export function expandEnvRefs(value: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof value === "string") {
    const m = ENV_REF_RE.exec(value)
    if (m === null) return value
    const resolved = env[m[1] ?? ""]
    return resolved === undefined || resolved === "" ? undefined : resolved
  }
  if (Array.isArray(value)) return value.map((v) => expandEnvRefs(v, env))
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = expandEnvRefs(v, env)
    return out
  }
  return value
}
