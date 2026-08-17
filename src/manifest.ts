import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
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

function validateAnnotations(raw: unknown, filePath: string): Record<string, string> | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) {
    fail(filePath, "annotations", "must be an object with string values")
  }
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") {
      fail(filePath, `annotations.${key}`, "must be a string")
    }
  }
  return raw as Record<string, string>
}

function validateFrom(raw: unknown, filePath: string): string | string[] | undefined {
  if (raw === undefined) return undefined
  if (typeof raw === "string") {
    if (raw === "") fail(filePath, "from", "must not be an empty string")
    return raw
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    fail(filePath, "from", "must be a string or a non-empty array of strings")
  }
  for (const [index, value] of raw.entries()) {
    if (typeof value !== "string" || value === "") {
      fail(filePath, `from[${index}]`, "must be a non-empty string")
    }
  }
  return raw as string[]
}

function validateCopy(raw: unknown, filePath: string): CopyEntry[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.length === 0) {
    fail(filePath, "copy", "must be a non-empty array")
  }
  return raw.map((item, index) => {
    const prefix = `copy[${index}]`
    if (!isRecord(item)) {
      fail(filePath, prefix, "must be an object")
    }
    const from = item["from"]
    if (typeof from !== "string" || from === "") {
      fail(filePath, `${prefix}.from`, "must be a non-empty string")
    }
    const paths = item["paths"]
    if (!Array.isArray(paths) || paths.length === 0) {
      fail(filePath, `${prefix}.paths`, "must be a non-empty array of strings")
    }
    for (const [pathIndex, path] of paths.entries()) {
      if (typeof path !== "string" || path === "") {
        fail(filePath, `${prefix}.paths[${pathIndex}]`, "must be a non-empty string")
      }
    }
    return { from, paths: paths as string[] }
  })
}

function validateAssets(raw: unknown, filePath: string): string | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== "string" || raw === "") {
    fail(filePath, "assets", "must be a non-empty string")
  }
  return raw
}

export function validateBuildManifest(raw: unknown, filePath: string): BuildManifestFile {
  if (!isRecord(raw)) {
    fail(filePath, "top level", "must be a JSON object")
  }

  const knownKeys = new Set(["annotations", "from", "copy", "assets", "gen", ...LEGACY_FIELDS])
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

  const result: BuildManifestFile = {}
  const annotations = validateAnnotations(raw["annotations"], filePath)
  if (annotations !== undefined) result.annotations = annotations
  const from = validateFrom(raw["from"], filePath)
  if (from !== undefined) result.from = from
  const copy = validateCopy(raw["copy"], filePath)
  if (copy !== undefined) result.copy = copy
  const assets = validateAssets(raw["assets"], filePath)
  if (assets !== undefined) result.assets = assets
  const gen = raw["gen"]
  if (gen !== undefined) result.gen = validateGenSpec(gen, filePath)
  return result
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
