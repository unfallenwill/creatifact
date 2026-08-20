import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { formatIssuePath, manifestSchema } from "./contract"
import { type GenSpec, validateGenSpec } from "./genPackage"

export type { GenSpec }

export interface CopyEntry {
  from: string
  paths: string[]
}

/** One orchestration stage: a mini build whose outputs other stages reference. */
export interface BuildStage {
  name: string
  annotations?: Record<string, string>
  from?: string | string[]
  copy?: CopyEntry[]
  assets?: string
  gen?: GenSpec
}

export interface BuildManifestFile {
  annotations?: Record<string, string>
  from?: string | string[]
  copy?: CopyEntry[]
  assets?: string
  gen?: GenSpec
  stages?: BuildStage[]
}

export interface LoadedManifest {
  file: BuildManifestFile
  baseDir: string
}

const LEGACY_FIELDS = ["tag", "dir", "output"] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function fail(filePath: string, field: string, message: string): never {
  throw new Error(`${filePath}: ${field} ${message}`)
}

/** Warn about unknown and legacy manifest keys (kept out of the main flow). */
function warnUnknownKeys(raw: Record<string, unknown>, filePath: string): void {
  const knownKeys = new Set([
    ...Object.keys(manifestSchema.shape),
    "gen",
    "stages",
    // stage entries carry their reference name
    ...(filePath.includes("#stages[") ? ["name"] : []),
    // standard JSON-Schema directive; editor tooling, not consumed here
    "$schema",
    ...LEGACY_FIELDS,
  ])
  for (const key of Object.keys(raw)) {
    if (!knownKeys.has(key)) {
      console.warn(`${filePath}: unknown field '${key}' is ignored`)
    }
  }
  for (const key of LEGACY_FIELDS) {
    if (raw[key] !== undefined) {
      console.warn(
        `${filePath}: field '${key}' was removed; pass it via CLI (-t / --dir / -o) instead`,
      )
    }
  }
}

/** Validate the stages array: named, unique, and free of top-level mixing. */
function validateStages(
  stagesRaw: unknown,
  filePath: string,
  hasTopLevelSections: boolean,
): BuildStage[] {
  if (hasTopLevelSections) {
    fail(
      filePath,
      "stages",
      "cannot combine 'stages' with top-level from/copy/assets/gen (put those on a stage)",
    )
  }
  if (!Array.isArray(stagesRaw) || stagesRaw.length === 0) {
    fail(filePath, "stages", "must be a non-empty array")
  }
  const names = new Set<string>()
  return stagesRaw.map((entry, i) => {
    if (!isRecord(entry)) fail(filePath, `stages[${i}]`, "must be an object")
    const name = entry["name"]
    if (typeof name !== "string" || name === "") {
      fail(filePath, `stages[${i}].name`, "is required (stages are referenced by name)")
    }
    if (names.has(name)) fail(filePath, `stages[${i}].name`, `'${name}' is used more than once`)
    names.add(name)
    // The per-stage shape reuses the manifest schema; name rides along.
    const stage = validateBuildManifest(entry, `${filePath}#stages[${i}]`)
    return { name, ...stage }
  })
}

/**
 * Validate a build manifest's non-gen sections through contract.ts's
 * manifestSchema (the same source that generates
 * schemas/creatifact-build.schema.json), then the gen section through
 * validateGenSpec so its unknown-key warnings stay intact.
 */
export function validateBuildManifest(raw: unknown, filePath: string): BuildManifestFile {
  if (!isRecord(raw)) {
    fail(filePath, "top level", "must be a JSON object")
  }
  warnUnknownKeys(raw, filePath)

  const result = manifestSchema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]
    fail(
      filePath,
      issue === undefined ? "manifest" : formatIssuePath(issue.path),
      issue?.message ?? "",
    )
  }

  const { annotations, from, copy, assets } = result.data
  const gen = raw["gen"]
  const stagesRaw = raw["stages"]
  const hasTopLevel =
    gen !== undefined || from !== undefined || copy !== undefined || assets !== undefined
  const stages =
    stagesRaw === undefined ? undefined : validateStages(stagesRaw, filePath, hasTopLevel)

  return {
    ...(annotations === undefined ? {} : { annotations }),
    // the schema's array branch carries unknown[] (element constraints ride
    // in its refine); a successful parse guarantees string elements here.
    ...(from === undefined ? {} : { from: from as string | string[] }),
    ...(copy === undefined ? {} : { copy }),
    ...(assets === undefined ? {} : { assets }),
    ...(gen === undefined ? {} : { gen: validateGenSpec(gen, filePath) }),
    ...(stages === undefined ? {} : { stages }),
  }
}

export async function loadBuildManifest(filePath: string): Promise<LoadedManifest> {
  const baseDir = dirname(resolve(filePath))
  try {
    const content = await readFile(filePath, "utf8")
    const raw: unknown = JSON.parse(content)
    return { file: validateBuildManifest(raw, filePath), baseDir }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { file: {}, baseDir }
    }
    throw e
  }
}
