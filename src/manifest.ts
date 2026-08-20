import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { formatIssuePath, manifestSchema } from "./contract"
import { type GenSpec, validateGenSpec } from "./genPackage"

export type { GenSpec }

export interface CopyEntry {
  from: string
  paths: string[]
}

export interface BuildManifestFile {
  annotations?: Record<string, string>
  from?: string | string[]
  copy?: CopyEntry[]
  assets?: string
  gen?: GenSpec
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
  return {
    ...(annotations === undefined ? {} : { annotations }),
    // the schema's array branch carries unknown[] (element constraints ride
    // in its refine); a successful parse guarantees string elements here.
    ...(from === undefined ? {} : { from: from as string | string[] }),
    ...(copy === undefined ? {} : { copy }),
    ...(assets === undefined ? {} : { assets }),
    ...(gen === undefined ? {} : { gen: validateGenSpec(gen, filePath) }),
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
