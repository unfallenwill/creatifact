import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { formatIssuePath, manifestSchema } from "./contract"
import { usageError } from "./errors"
import { stripJsonc } from "./jsonc"
import { type RunSpec, validateRunSpec } from "./runPackage"

export type { RunSpec }

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
  run?: RunSpec
}

export interface BuildManifestFile {
  annotations?: Record<string, string>
  from?: string | string[]
  copy?: CopyEntry[]
  assets?: string
  run?: RunSpec
  stages?: BuildStage[]
}

export interface LoadedManifest {
  file: BuildManifestFile
  baseDir: string
}

const LEGACY_FIELDS = ["tag", "dir", "output"] as const
/** Fields renamed by the gen→run unification; fail loudly so a stale recipe is never silently dropped. */
const RENAMED_FIELDS = new Map([["gen", "run"]])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function fail(filePath: string, field: string, message: string): never {
  throw new Error(`${filePath}: ${field} ${message}`)
}

/** Fail on renamed fields; warn about unknown and legacy keys (kept out of the main flow). */
function warnUnknownKeys(raw: Record<string, unknown>, filePath: string): void {
  for (const [oldName, newName] of RENAMED_FIELDS) {
    if (raw[oldName] !== undefined) {
      fail(filePath, oldName, `was renamed to '${newName}'`)
    }
  }
  const knownKeys = new Set([
    ...Object.keys(manifestSchema.shape),
    "run",
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
      "cannot combine 'stages' with top-level from/copy/assets/run (put those on a stage)",
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
 * Validate a build manifest's non-run sections through contract.ts's
 * manifestSchema (the same source that generates
 * schemas/creatifact-build.schema.json), then the run section through
 * validateRunSpec so its unknown-key warnings stay intact.
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
  const run = raw["run"]
  const stagesRaw = raw["stages"]
  const hasTopLevel =
    run !== undefined || from !== undefined || copy !== undefined || assets !== undefined
  const stages =
    stagesRaw === undefined ? undefined : validateStages(stagesRaw, filePath, hasTopLevel)

  return {
    ...(annotations === undefined ? {} : { annotations }),
    // the schema's array branch carries unknown[] (element constraints ride
    // in its refine); a successful parse guarantees string elements here.
    ...(from === undefined ? {} : { from: from as string | string[] }),
    ...(copy === undefined ? {} : { copy }),
    ...(assets === undefined ? {} : { assets }),
    ...(run === undefined ? {} : { run: validateRunSpec(run, filePath) }),
    ...(stages === undefined ? {} : { stages }),
  }
}

/**
 * Resolve run.promptFile (relative to the manifest directory) into run.prompt
 * and drop the field. The manifest on disk keeps the authoring reference;
 * fingerprints, --bake packages, and execution only ever see the inlined
 * prompt, so artifacts stay self-contained and prompt-file edits re-run the
 * stages that consume them.
 */
async function inlinePromptFiles(
  file: BuildManifestFile,
  filePath: string,
  baseDir: string,
): Promise<void> {
  const runs: RunSpec[] = []
  if (file.run !== undefined) runs.push(file.run)
  for (const stage of file.stages ?? []) {
    if (stage.run !== undefined) runs.push(stage.run)
  }
  for (const run of runs) {
    const ref = run.promptFile
    if (ref === undefined) continue
    const abs = resolve(baseDir, ref)
    let content: string
    try {
      content = await readFile(abs, "utf8")
    } catch (e) {
      throw usageError(
        `${filePath}: run.promptFile '${ref}' cannot be read: ${(e as Error).message}`,
      )
    }
    const prompt = content.trim()
    if (prompt === "") {
      throw usageError(`${filePath}: run.promptFile '${ref}' is empty`)
    }
    run.prompt = prompt
    delete run.promptFile
  }
}

export async function loadBuildManifest(filePath: string): Promise<LoadedManifest> {
  const baseDir = dirname(resolve(filePath))
  let file: BuildManifestFile
  try {
    const content = await readFile(filePath, "utf8")
    let raw: unknown
    try {
      raw = JSON.parse(stripJsonc(content))
    } catch (e) {
      throw usageError(`${filePath}: not valid JSON/JSONC: ${(e as Error).message}`)
    }
    file = validateBuildManifest(raw, filePath)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { file: {}, baseDir }
    }
    throw e
  }
  await inlinePromptFiles(file, filePath, baseDir)
  return { file, baseDir }
}
