/**
 * Build planning: the pure "resolve → fingerprint → plan" half of `build`.
 * Execution (src/build.ts) consumes these primitives to skip stages whose
 * inputs are unchanged, and to render the dry-run `--plan` report.
 *
 * Everything here is read-only: no provider calls, no store writes. A
 * fingerprint covers the *resolved* stage — spec, reference values, source
 * digests, assets tree — not the manifest text, so whitespace-only edits
 * stay cheap and downstream stages re-run exactly when an upstream digest
 * they reference changes.
 */
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { isAbsolute, join } from "node:path"

import { glob } from "tinyglobby"

import { stableStringify } from "./contract"
import { dagEdges } from "./dag"
import { type OCIManifest, REF_NAME_ANNOTATION, readIndexEntries } from "./oci"
import { isLocalRef } from "./refs"
import {
  isCreatifactPackage,
  type PackageMetadata,
  type RunSpec,
  readMetadataFromLayout,
} from "./runPackage"

export const PLAN_SCHEMA_VERSION = 1

/** One resolved from/copy source: the spec plus its digest when local. */
export interface SourceDigest {
  from: string
  digest?: string
}

/** Everything that affects one stage's output, after reference resolution. */
export interface StageInputs {
  /** Build-level context that changes behavior: the default run provider. */
  defaultProvider?: string
  run?: RunSpec
  from: SourceDigest[]
  copy: Array<SourceDigest & { paths: string[] }>
  assets?: string
  annotations?: Record<string, string>
}

/** Content-address one resolved stage's inputs (key-order insensitive). */
export function fingerprintStage(inputs: StageInputs): string {
  return `sha256:${createHash("sha256").update(stableStringify(inputs)).digest("hex")}`
}

/** Resolve a from/copy source to a digest when it is local (layout dir or
 * store tag). Registry refs resolve to undefined — callers keep the ref
 * string in the fingerprint (no network during planning). */
export async function resolveSourceDigest(
  spec: string,
  baseDir: string,
  storeDir: string,
): Promise<string | undefined> {
  const localPath = isAbsolute(spec) ? spec : join(baseDir, spec)
  if (isLocalRef(spec) || (existsSync(localPath) && (await stat(localPath)).isDirectory())) {
    const entries = await readIndexEntries(localPath)
    return entries[0]?.digest
  }
  const inStore = (await readIndexEntries(storeDir)).find(
    (m) => m.annotations?.[REF_NAME_ANNOTATION] === spec,
  )
  return inStore?.digest
}

/** Hash an assets dir tree: sorted relative paths + file bytes. Matches
 * createLayerTarball's traversal (dotfiles, onlyFiles, sorted), so identical
 * trees hash identically regardless of filesystem entry order. */
export async function hashAssetsDir(dir: string): Promise<string> {
  const files = (await glob(["**/*"], { cwd: dir, onlyFiles: true, dot: true })).sort()
  const hash = createHash("sha256")
  for (const rel of files) {
    hash.update(rel)
    hash.update("\0")
    hash.update(await readFile(join(dir, rel)))
    hash.update("\0")
  }
  return `sha256:${hash.digest("hex")}`
}

/** Stage names in topological order (Kahn's algorithm); throws on cycles. */
export function topoOrder(names: string[], payloadOf: (name: string) => unknown): string[] {
  const indegree = new Map<string, number>(names.map((n) => [n, 0]))
  const outgoing = new Map<string, string[]>(names.map((n) => [n, []]))
  for (const [from, to] of dagEdges(names, payloadOf)) {
    outgoing.get(from)?.push(to)
    indegree.set(to, (indegree.get(to) ?? 0) + 1)
  }
  const queue = names.filter((n) => indegree.get(n) === 0)
  const ordered: string[] = []
  while (queue.length > 0) {
    const current = queue.shift() as string
    ordered.push(current)
    for (const next of outgoing.get(current) ?? []) {
      const degree = (indegree.get(next) ?? 0) - 1
      indegree.set(next, degree)
      if (degree === 0) queue.push(next)
    }
  }
  if (ordered.length !== names.length) {
    throw new Error("build stages contain a reference cycle")
  }
  return ordered
}

/** Each stage's direct dependencies (the stage names its payload references). */
export function stageDependencies(
  names: string[],
  payloadOf: (name: string) => unknown,
): Map<string, string[]> {
  const map = new Map<string, string[]>(names.map((n) => [n, []]))
  for (const [from, to] of dagEdges(names, payloadOf)) map.get(to)?.push(from)
  return map
}

export interface PlanDigestEntry {
  name: string
  inputsDigest: string
  dependencies: string[]
}

/** Content-address a whole plan: stages, their inputs, and the target tag.
 * Stages are name-sorted so the digest survives reordered manifests. */
export function planDigestOf(stages: PlanDigestEntry[], targetTag: string): string {
  const payload = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    targetTag,
    stages: [...stages].sort((a, b) => a.name.localeCompare(b.name)),
  }
  return `sha256:${createHash("sha256").update(stableStringify(payload)).digest("hex")}`
}

/** The referenceable surface of a previously built stage (from the store). */
export interface PreviousStageResult {
  digest: string
  tag: string
  outputDir: string
  artifacts: Array<{ name?: string; url?: string; mimeType?: string | undefined }>
}

async function readManifestBlob(
  storeDir: string,
  digest: string,
): Promise<OCIManifest | undefined> {
  try {
    return JSON.parse(
      await readFile(join(storeDir, "blobs", "sha256", digest.slice("sha256:".length)), "utf8"),
    ) as OCIManifest
  } catch {
    return undefined
  }
}

/** Recover a previous stage's referenceable result from the shared store.
 * Returns undefined when the entry's blobs are gone (defensive: callers
 * then re-execute the stage). */
export async function readPreviousStageResult(
  storeDir: string,
  digest: string,
  tag: string,
): Promise<PreviousStageResult | undefined> {
  const manifest = await readManifestBlob(storeDir, digest)
  if (manifest === undefined) return undefined
  let artifacts: PreviousStageResult["artifacts"] = []
  if (isCreatifactPackage(manifest)) {
    const metadata: PackageMetadata | undefined = await readMetadataFromLayout(storeDir, manifest)
    artifacts = metadata?.result?.artifacts ?? []
  }
  return { digest, tag, outputDir: storeDir, artifacts }
}
