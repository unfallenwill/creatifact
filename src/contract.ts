import { z } from "zod"
import type { ParsedArgs as BuildRequest, BuildResult } from "./build"
import type { GenerateResult, GenRequest } from "./generate"
import type { ParsedLoginArgs } from "./login"
import type { ParsedPullArgs } from "./pull"
import type { ParsedPushArgs } from "./push"
import { type GenTaskName, requestFieldsForTask, TASKS } from "./tasks"

/**
 * The single source of truth for every externally visible contract:
 *
 *  1. `-f` request-file field validation (requestFile.ts parses through
 *     these schemas; no hand-rolled readers left behind),
 *  2. gen-recipe validation (genPackage.ts / manifest.ts),
 *  3. `schemas/*.json` — generated at build time from these definitions
 *     (`npm run gen:schemas`); hand edits are rejected by the drift gate,
 *  4. pipeline referenceable fields (pipeline.ts reads the constants below;
 *     each is compile-time locked to `keyof <Result>`),
 *  5. README's documented output contract (asserted against the constants).
 *
 * Adding a field to a request type without adding it here fails `typecheck`;
 * changing a constraint here regenerates the JSON Schemas in CI. There is
 * exactly one place to change any contract facet.
 */

// ---------------------------------------------------------------------------
// Atomic constraints — messages match the historical validators verbatim.

const NON_EMPTY = "must be a non-empty string"
const STRING_OR_LIST = "must be a string or an array of non-empty strings"
const SPEC_LIST = "must be a non-empty string or an array of non-empty strings"
const DURATION = 'must be a duration string (e.g. "5m") or milliseconds'
const MUST_BE_OBJECT = "must be an object"
const MUST_BE_BOOL = "must be a boolean"

export const nonEmptyString = z.string({ error: NON_EMPTY }).min(1, { error: NON_EMPTY })
export const boolField = z.boolean({ error: MUST_BE_BOOL })
export const recordField = z.record(z.string(), z.unknown(), { error: MUST_BE_OBJECT })

/** `-f` list fields: a bare string or any string array (may be empty). */
export const requestListField = z.union([nonEmptyString, z.array(nonEmptyString)], {
  error: STRING_OR_LIST,
})

/** Gen-spec list fields: a non-empty string or a non-empty array of them. */
export const specListField = z.union(
  [nonEmptyString, z.array(nonEmptyString).min(1, { error: SPEC_LIST })],
  { error: SPEC_LIST },
)

/** timeout / interval: duration string or positive milliseconds. */
export const durationField = z.union(
  [
    z.string(),
    z.number({ error: DURATION }).refine((v) => Number.isFinite(v) && v > 0, { error: DURATION }),
  ],
  { error: DURATION },
)

/** resume handle: inline JSON string or the saved object itself. */
export const handleField = z.union([nonEmptyString, recordField], {
  error: `${NON_EMPTY} or ${MUST_BE_OBJECT}`,
})

// ---------------------------------------------------------------------------
// Shared `-f` fields. TAG_DESCRIPTION is shared by two schema objects
// (generate's optional tag, build's required tag); every other description
// lives directly on its single field const.

const providerField = nonEmptyString.describe(
  "Provider id, optionally with model: 'zhipu' or 'zhipu/cogview-4'. Omit to use the default provider (config key defaults.gen.provider).",
)
const outputField = nonEmptyString.describe(
  "Result OCI layout directory for packaging tasks (media always; text/embed opt-in with --tag). Resume / --no-pack: directory to save artifacts. Also used by build / pull.",
)
const TAG_DESCRIPTION =
  "Reference name for the result package (default gen-output:latest). Media tasks pack by default; text/embed tasks pack only when tag/output is set. Also build's image reference."
const tagField = nonEmptyString.describe(TAG_DESCRIPTION)

/** Compile-time lock: a table's keys must be exactly the request type minus
 * fields the CLI/runtime derives itself (passwordStdin, action, rest, ...).
 * Adding a request-type field without a table entry (or vice versa) fails
 * typecheck instead of silently accepting/rejecting the wrong JSON keys. */
type assertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

// ---------------------------------------------------------------------------
// generate.* request fields (the JSON face of GenRequest).

/**
 * Every `-f` JSON field accepted by `generate.<task>` commands, in required
 * (unwrapped) form. `task`, `promptRef`, and `inputRefs` are excluded: the
 * first comes from the command name itself, the latter two are internal
 * pipeline bookkeeping, never accepted from JSON input. Consumers wrap
 * fields in `.optional()` themselves (requiredness is the consumer's
 * business: all-optional for generate requests, per-command for the schema
 * branches).
 */
export const generateRequestFields = {
  provider: providerField,
  model: nonEmptyString.describe("Model id (overrides any model in 'provider')."),
  prompt: nonEmptyString.describe(
    "Text instruction or question (generate.text2text / text2image / image2image / text2video / image2video / frames2video; optional for image2text / video2text).",
  ),
  system: nonEmptyString.describe("System prompt (generate.text2text only)."),
  images: requestListField.describe(
    "Reference image(s): http(s)/data URL, local path, or pkg://path into a recipe package. Repeatable as --image. Exactly one for image2image and image2video.",
  ),
  firstFrame: nonEmptyString.describe("generate.frames2video only: first frame image."),
  lastFrame: nonEmptyString.describe("generate.frames2video only: last frame image."),
  inputs: requestListField.describe(
    "Media attachments (generate.image2text / video2text) or texts to embed (generate.embed). Repeatable as --input.",
  ),
  options: recordField.describe("Provider-specific options (passed as --opt k=v)."),
  noWait: boolField.describe("Video tasks only: submit and print the task handle without polling."),
  timeout: durationField.describe(
    'Video tasks and resume: polling timeout, duration string (e.g. "5m") or milliseconds.',
  ),
  interval: durationField.describe(
    'Video tasks and resume: polling interval, duration string (e.g. "5s") or milliseconds.',
  ),
  output: outputField,
  tag: tagField,
  noPack: boolField.describe(
    "Media tasks only: return artifacts without building a result package.",
  ),
  handle: handleField.describe(
    "generate.resume only: the saved task handle (object or inline JSON string).",
  ),
} as const

const _genFaceCheck: assertExact<
  keyof typeof generateRequestFields,
  Exclude<keyof GenRequest, "task" | "promptRef" | "inputRefs">
> = true
void _genFaceCheck

/** Milliseconds → duration string, preserving the historical format. */
function msToDuration(ms: number): string {
  return ms % 1000 === 0 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms)}ms`
}

/** The JSON input face of one generate field (before normalization). */
export type GenerateFieldJson<K extends keyof GenRequest & string> = K extends "images" | "inputs"
  ? string | string[]
  : K extends "timeout" | "interval"
    ? string | number
    : K extends "handle"
      ? string | Record<string, unknown>
      : GenRequest[K]

/** Field-normalization rules, untyped core (see the typed wrapper below). */
function normalizeGenerateValue(field: string, value: unknown): unknown {
  switch (field) {
    case "images":
    case "inputs":
      return Array.isArray(value) ? value : [value]
    case "timeout":
    case "interval":
      return typeof value === "number" ? msToDuration(value) : value
    case "handle":
      return typeof value === "string" ? value : JSON.stringify(value)
    default:
      return value
  }
}

/**
 * Normalize an already-validated generate-field value into its GenRequest
 * form: bare strings for list fields wrap into arrays, numeric durations
 * become duration strings, handle objects become inline JSON strings. Lives
 * next to the schema table so the two never drift apart; typed end-to-end
 * (JSON face in, GenRequest field out).
 */
export function normalizeGenerateField<K extends keyof GenRequest & string>(
  field: K,
  value: GenerateFieldJson<K>,
): GenRequest[K] {
  return normalizeGenerateValue(field, value) as GenRequest[K]
}

/** Normalize a validated build-field value (annotations stringify values). */
export function normalizeBuildField(field: string, value: unknown): unknown {
  if (field === "annotations" && typeof value === "object" && value !== null) {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(value)) out[k] = String(v)
    return out
  }
  return value
}

// ---------------------------------------------------------------------------
// Non-generate command fields, in required (unwrapped) form. Consumers wrap
// fields in `.optional()` themselves; each table carries a compile-time lock
// against its request type.

export const buildRequestFields = {
  tag: nonEmptyString.describe(TAG_DESCRIPTION),
  dir: nonEmptyString.describe("build only: local directory packed as the top layer."),
  file: nonEmptyString.describe("Build manifest path (build)."),
  output: nonEmptyString.describe(
    "Result OCI layout directory for packaging tasks (media always; text/embed opt-in with --tag). Resume / --no-pack: directory to save artifacts. Also used by build / pull.",
  ),
  annotations: z
    .record(z.string(), z.unknown(), { error: MUST_BE_OBJECT })
    .describe("build only: manifest annotations (values are stringified)."),
  username: nonEmptyString.describe("Registry username (package.* / auth.login)."),
  password: nonEmptyString.describe("Registry password (package.* / auth.login)."),
  plainHttp: boolField.describe("Use HTTP instead of HTTPS for the registry."),
  // plan/bake/force are CLI-only (never -f JSON fields): excluded from the
  // -f face.
} as const

const _buildFaceCheck: assertExact<
  keyof typeof buildRequestFields,
  Exclude<keyof BuildRequest, "passwordStdin" | "plan" | "bake" | "force">
> = true
void _buildFaceCheck

export const pushRequestFields = {
  ref: nonEmptyString.describe(
    "push / pull only: registry reference, e.g. localhost:5000/myrepo:1.0.",
  ),
  layout: nonEmptyString.describe("push only: OCI layout directory (default ./oci-layout)."),
  username: nonEmptyString.describe("Registry username (package.* / auth.login)."),
  password: nonEmptyString.describe("Registry password (package.* / auth.login)."),
  plainHttp: boolField.describe("Use HTTP instead of HTTPS for the registry."),
} as const

const _pushFaceCheck: assertExact<
  keyof typeof pushRequestFields,
  Exclude<keyof ParsedPushArgs, "passwordStdin">
> = true
void _pushFaceCheck

export const pullRequestFields = {
  ref: nonEmptyString.describe(
    "push / pull only: registry reference, e.g. localhost:5000/myrepo:1.0.",
  ),
  output: nonEmptyString.describe(
    "Result OCI layout directory for packaging tasks (media always; text/embed opt-in with --tag). Resume / --no-pack: directory to save artifacts. Also used by build / pull.",
  ),
  username: nonEmptyString.describe("Registry username (package.* / auth.login)."),
  password: nonEmptyString.describe("Registry password (package.* / auth.login)."),
  plainHttp: boolField.describe("Use HTTP instead of HTTPS for the registry."),
} as const

const _pullFaceCheck: assertExact<
  keyof typeof pullRequestFields,
  Exclude<keyof ParsedPullArgs, "passwordStdin">
> = true
void _pullFaceCheck

export const loginRequestFields = {
  registry: nonEmptyString.describe("auth.login / auth.logout only: registry host[:port]."),
  username: nonEmptyString.describe("Registry username (package.* / auth.login)."),
  password: nonEmptyString.describe("Registry password (package.* / auth.login)."),
} as const

const _loginFaceCheck: assertExact<
  keyof typeof loginRequestFields,
  Exclude<keyof ParsedLoginArgs, "passwordStdin">
> = true
void _loginFaceCheck

// auth.logout / config.* / models take no dedicated ParsedArgs type (their
// CLI args are inline positional/optional forms), so there is nothing to
// compile-lock against — the command-executable schema test covers them.

export const logoutRequestFields = {
  registry: nonEmptyString.describe("auth.login / auth.logout only: registry host[:port]."),
} as const

export const configGetFields = {
  key: nonEmptyString.describe("config.get / config.set only: dotted config key."),
} as const

export const configSetFields = {
  key: nonEmptyString.describe("config.get / config.set only: dotted config key."),
  value: z.json().describe("config.set only: the value to store (typed JSON)."),
} as const

export const modelsRequestFields = {
  provider: nonEmptyString.describe(
    "Provider id, optionally with model: 'zhipu' or 'zhipu/cogview-4'. Omit to use the default provider (config key defaults.gen.provider).",
  ),
} as const

/** The bag of JSON fields a request file step/command carries. */
export type Fields = Record<string, unknown>

// ---------------------------------------------------------------------------
// Gen recipe (`gen:` in build manifests and package config blobs).

/** Gen tasks that can be baked as a recipe (`resume` cannot). */
const GEN_RECIPE_TASKS = Object.keys(TASKS).filter(
  (t): t is Exclude<GenTaskName, "resume"> => t !== "resume",
)

const RECIPE_TASKS_MESSAGE = `must be one of ${GEN_RECIPE_TASKS.join(", ")}`

const promptRefSchema = z.object(
  {
    name: nonEmptyString.optional().exactOptional(),
    digest: nonEmptyString.optional().exactOptional(),
    tag: nonEmptyString.optional().exactOptional(),
  },
  { error: "must be an object {name?, digest?, tag?}" },
)
const PROVENANCE_FIELDS = ["images", "firstFrame", "lastFrame", "inputs"] as const

const inputProvenanceSchema = z.object(
  {
    field: z.enum(PROVENANCE_FIELDS, {
      error: `must be one of ${PROVENANCE_FIELDS.join(", ")}`,
    }),
    name: nonEmptyString,
    index: z
      .number({ error: "must be a non-negative integer" })
      .int({ error: "must be a non-negative integer" })
      .min(0, { error: "must be a non-negative integer" })
      .optional()
      .exactOptional(),
    digest: nonEmptyString.optional().exactOptional(),
    tag: nonEmptyString.optional().exactOptional(),
  },
  { error: "must be an object" },
)

/**
 * The `gen` recipe object. Loose: unknown keys are warned about and ignored
 * by the validators, not rejected. exactOptional keeps the inferred output
 * assignable to GenSpec under tsconfig's exactOptionalPropertyTypes.
 */
const genSpecShape = {
  task: z
    .enum(GEN_RECIPE_TASKS as [GenTaskName, ...GenTaskName[]], {
      error: () => RECIPE_TASKS_MESSAGE,
    })
    .describe("Generation task."),
  provider: nonEmptyString
    .optional()
    .exactOptional()
    .describe("Provider id, optionally with model: 'zhipu' or 'zhipu/cogview-4'."),
  model: nonEmptyString
    .optional()
    .exactOptional()
    .describe("Model id (overrides any model in 'provider')."),
  prompt: nonEmptyString
    .optional()
    .exactOptional()
    .describe("Default prompt (overridable via the positional prompt at generate time)."),
  promptRef: promptRefSchema
    .optional()
    .exactOptional()
    .describe(
      "Provenance for a prompt produced by an earlier pipeline step: {name?, digest?, tag?}. digest anchors the source package content-addressedly.",
    ),
  inputRefs: z
    .array(inputProvenanceSchema, { error: "must be a non-empty array" })
    .min(1, { error: "must be a non-empty array" })
    .optional()
    .exactOptional()
    .describe(
      "Provenance for media inputs that referenced an earlier step's artifacts: the URL sent to the provider expires, the digest anchors the source package that still holds the bytes.",
    ),
  system: nonEmptyString.optional().exactOptional().describe("System prompt (text2text only)."),
  images: specListField
    .optional()
    .exactOptional()
    .describe(
      "Reference image(s): http(s)/data URL, local path, or pkg://path into this package's layers (packed via assets).",
    ),
  firstFrame: nonEmptyString
    .optional()
    .exactOptional()
    .describe("frames2video only: first frame image (URL, local path, or pkg://path)."),
  lastFrame: nonEmptyString
    .optional()
    .exactOptional()
    .describe("frames2video only: last frame image (URL, local path, or pkg://path)."),
  inputs: specListField
    .optional()
    .exactOptional()
    .describe(
      "Media attachments (image2text/video2text) or texts (embed): URL, local path, pkg://path, or plain text.",
    ),
  options: recordField.optional().exactOptional().describe("Provider-specific generation options."),
}

export const genSpecSchema = z.looseObject(genSpecShape)
type GenSpecShape = typeof genSpecShape

/** Strip the undefined member from a union (distributive). */
type NoUndefined<T> = T extends undefined ? never : T

/**
 * A zod shape's output with clean optionals: required keys stay required,
 * optional keys lose their explicit `| undefined` so the type matches the
 * hand-written `?: T` style under exactOptionalPropertyTypes.
 */
type CleanShapeOutput<Shape extends z.ZodRawShape> = {
  [K in keyof Shape as undefined extends z.output<Shape[K]> ? K : never]?: NoUndefined<
    z.output<Shape[K]>
  >
} & {
  [K in keyof Shape as undefined extends z.output<Shape[K]> ? never : K]: z.output<Shape[K]>
}

/**
 * The parsed gen recipe type, derived from the schema shape so the two can
 * never drift. images/inputs are the normalized (always-array) form — the
 * schema accepts a bare string, validateGenSpec wraps it. `task` widens back
 * to GenTaskName to match historical call sites.
 */
export type GenSpec = Omit<CleanShapeOutput<GenSpecShape>, "images" | "inputs" | "task"> & {
  task: GenTaskName
  images?: string[]
  inputs?: string[]
}

/** Where a prompt came from: a packed result package, identified by digest. */
export type StepProvenance = z.output<typeof promptRefSchema>

/** Which request field an input provenance entry describes. */
export type InputProvenanceField = InputProvenance["field"]

/** Provenance for one media input entry that referenced an earlier step. */
export type InputProvenance = z.output<typeof inputProvenanceSchema>

// ---------------------------------------------------------------------------
// Build manifest (annotations / from / copy / assets) — the non-gen half of
// creatifact-build.schema.json, and manifest.ts's validators. The `gen`
// section reuses genSpecSchema at generation time; runtime keeps calling
// validateGenSpec for it so unknown-key warnings stay intact.

/**
 * `from`: non-empty string or non-empty array of non-empty strings.
 * Built as a permissive union (so z.toJSONSchema emits the oneOf shape)
 * plus a refine that reports bad array elements at their index — unions
 * collapse branch errors, so element constraints ride in the refine.
 */
const FROM_MESSAGE = "must be a string or a non-empty array of strings"

const manifestFromField = z
  .union([nonEmptyString, z.array(z.unknown()).min(1, { error: FROM_MESSAGE })], {
    error: FROM_MESSAGE,
  })
  .superRefine((val, ctx) => {
    if (typeof val === "string") return
    for (const [i, el] of val.entries()) {
      if (typeof el !== "string" || el === "") {
        ctx.addIssue({ code: "custom", path: [i], message: NON_EMPTY })
      }
    }
  })

const manifestCopySchema = z.object({
  from: nonEmptyString,
  paths: z.array(nonEmptyString).min(1, { error: "must be a non-empty array of strings" }),
})

const manifestCopyListField = z
  .array(manifestCopySchema, { error: "must be a non-empty array" })
  .min(1, { error: "must be a non-empty array" })

const manifestAnnotationsField = z.record(z.string(), z.string({ error: "must be a string" }), {
  error: "must be an object with string values",
})

export const manifestSchema = z.looseObject({
  annotations: manifestAnnotationsField
    .optional()
    .describe("Manifest annotations (image metadata)."),
  from: manifestFromField
    .optional()
    .describe(
      "Registry reference(s) or local OCI layout path(s) whose layers are inherited in order.",
    ),
  copy: manifestCopyListField
    .optional()
    .describe("Extract specific paths from a source image and add them as a new layer."),
  assets: nonEmptyString
    .optional()
    .describe("Local directory packed as the top layer (relative to this file)."),
})

/** Render a zod issue path (`["a", 0, "b"]`) as `a[0].b`. */
export function formatIssuePath(path: readonly PropertyKey[]): string {
  let out = ""
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`
    else if (out === "") out += String(seg)
    else out += `.${String(seg)}`
  }
  return out
}

// ---------------------------------------------------------------------------
// Pipeline referenceable fields — compile-time locked true subsets of each
// result type. Adding a GenerateResult field without deciding whether it is
// referenceable no longer silently drifts: update the constant or nothing.

const referenceableBuildFields = [
  "tag",
  "digest",
  "outputDir",
] as const satisfies readonly (keyof BuildResult)[]

const referenceableGenerateFields = [
  "tag",
  "digest",
  "outputDir",
  "text",
  "vectors",
  "dimensions",
] as const satisfies readonly (keyof GenerateResult)[]

/**
 * Which result fields each command kind exposes to later pipeline steps.
 * Presence-filtered at runtime: a field is only offered when the result
 * actually carries it. `artifacts[N].url` / `artifacts[N].base64` are extra
 * expression forms handled by pipeline.ts itself.
 */
export const REFERENCEABLE = {
  build: referenceableBuildFields,
  generate: referenceableGenerateFields,
} as const

// ---------------------------------------------------------------------------
// Request-file structure — the source for
// schemas/creatifact-request.schema.json. One closed branch per command
// (discriminated by the `command` literal): each branch carries exactly the
// fields its runtime parser accepts, with the fields the parser rejects as
// absent marked required. Built lazily by buildRequestFileSchema() — nothing
// here runs at module load; the CLI only pays for it when the schema is
// actually requested (gen:schemas / tests).

type JsonSchema = Record<string, unknown>

const SCHEMA_TARGET = { target: "draft-2020-12" } as const

/** Key-sorted stable stringify, for order-insensitive JSON comparisons. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

/** The fixed (non-generate) commands a request file / pipeline step can run. */
const NON_GENERATE_COMMANDS = [
  "build",
  "push",
  "pull",
  "auth.login",
  "auth.logout",
  "config.path",
  "config.list",
  "config.get",
  "config.set",
  "config.reset",
  "models",
] as const

/** Every command name a request file (root or step) accepts. */
export function requestFileCommands(): string[] {
  return [...Object.keys(TASKS).map((t) => `generate.${t}`), ...NON_GENERATE_COMMANDS]
}

/** Root-only `$schema` hint (the runtime strips it from the root only). */
const schemaRefField = z.string().optional().describe("Optional schema reference (ignored).")

/**
 * One closed command branch: `command` literal + `extra` (step `name` or
 * root `$schema`) + the command's fields, all optional except `required`.
 * generate.* keeps every payload field optional — the documented flow lets
 * CLI flags and the positional prompt complete a file-supplied request, so
 * requiredness would false-positive legal files.
 */
function commandBranch(
  command: string,
  core: Record<string, z.ZodType>,
  required: readonly string[],
  extra: Record<string, z.ZodType>,
): z.ZodObject {
  const shape: Record<string, z.ZodType> = {
    command: z.literal(command).describe("Which command to run."),
    ...extra,
  }
  for (const [name, schema] of Object.entries(core)) {
    shape[name] = required.includes(name) ? schema : schema.optional()
  }
  return z.strictObject(shape)
}

/**
 * Every command with its field table and runtime-required keys, generate.*
 * first (field set per task from the task registry).
 */
function commandBranchSpecs(): Array<[string, Record<string, z.ZodType>, readonly string[]]> {
  const all = generateRequestFields as Record<string, z.ZodType>
  const generate: Array<[string, Record<string, z.ZodType>, readonly string[]]> = (
    Object.keys(TASKS) as GenTaskName[]
  ).map((task) => {
    const allowed = requestFieldsForTask(task)
    const fields = Object.fromEntries(Object.entries(all).filter(([name]) => allowed.has(name)))
    return [`generate.${task}`, fields, [] as readonly string[]]
  })
  return [
    ...generate,
    ["build", buildRequestFields as Record<string, z.ZodType>, ["tag"]],
    ["push", pushRequestFields as Record<string, z.ZodType>, ["ref"]],
    ["pull", pullRequestFields as Record<string, z.ZodType>, ["ref"]],
    ["auth.login", loginRequestFields as Record<string, z.ZodType>, ["registry"]],
    ["auth.logout", logoutRequestFields as Record<string, z.ZodType>, ["registry"]],
    ["config.get", configGetFields as Record<string, z.ZodType>, ["key"]],
    ["config.set", configSetFields as Record<string, z.ZodType>, ["key", "value"]],
    ["models", modelsRequestFields as Record<string, z.ZodType>, []],
    ["config.path", {}, []],
    ["config.list", {}, []],
    ["config.reset", {}, []],
  ]
}

/**
 * The build-manifest root schema: manifest.ts's sections plus the gen
 * recipe — the source for schemas/creatifact-build.schema.json.
 */
const buildManifestFileSchema = z.looseObject({
  ...manifestSchema.shape,
  gen: genSpecSchema.describe(
    "Generation section (RUN): executed during build (unless --plan) — pkg:// refs resolve against the layers above; artifacts become the top layer and the config records the executed spec. Never contains credentials.",
  ),
})

/**
 * schemas/creatifact-request.schema.json, assembled from the contract: the
 * -f request file is the exact JSON mirror of one command line, so the root
 * is the single closed branch per command (plus $schema). Orchestration is
 * the build manifest's job (stages), not a request-file form. Built
 * lazily; the CLI only pays for this when the schema is actually requested.
 */
export function requestFileSchemaJson(): JsonSchema {
  const defs: Record<string, JsonSchema> = {}
  const singles: JsonSchema[] = []
  for (const [command, fields, required] of commandBranchSpecs()) {
    defs[`single.${command}`] = z.toJSONSchema(
      commandBranch(command, fields, required, { $schema: schemaRefField }),
      SCHEMA_TARGET,
    ) as JsonSchema
    singles.push({ $ref: `#/$defs/single.${command}` })
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://raw.githubusercontent.com/unfallenwill/creatifact/main/schemas/creatifact-request.schema.json",
    title: "Creatifact request file",
    description:
      "The JSON mirror of one creatifact command line, run via `creatifact -f <file>.json`. The 'command' field selects the command; the remaining fields map to its arguments exactly as the flags would, and command-line flags after the file override generate.* fields. Orchestration (multi-step, dependency graph) lives in creatifact-build.json stages.",
    $defs: defs,
    anyOf: singles,
  }
}

/** schemas/creatifact-build.schema.json, generated from the contract. */
export function buildManifestSchemaJson(): JsonSchema {
  const json = z.toJSONSchema(buildManifestFileSchema, SCHEMA_TARGET) as JsonSchema
  return {
    ...json,
    $id: "https://raw.githubusercontent.com/unfallenwill/creatifact/main/schemas/creatifact-build.schema.json",
    title: "Creatifact build manifest",
    description:
      "Describes an OCI image: annotations, base images to inherit, paths to copy, and a local assets directory.",
  }
}
