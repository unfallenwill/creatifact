/**
 * Generic DAG executor (p-graph philosophy: the graph is data). Callers
 * declare named nodes plus each node's field-like payload; every
 * `${name.field}` reference found in a payload is a scheduling edge, and
 * the executor derives the plan: independent nodes run concurrently up to
 * the configured width, referenced nodes complete first. Placeholder
 * resolution is lazy per node (a node's fields resolve the moment its last
 * dependency completes). A failed node fails the run immediately (fail
 * fast): not-yet-started nodes are skipped and reported with a reason;
 * completed nodes survive in the outcomes map.
 */
import { type DependencyList, PGraph, PGraphError, type PGraphNodeMap } from "p-graph"

/** One `${name.field}` / `${name.field[N].prop}` reference. */
export interface DagRef {
  name: string
  field: string
  index?: number | undefined
  prop?: string | undefined
}

const REF_RE =
  /\$\{([a-zA-Z][a-zA-Z0-9_]*)\.([a-zA-Z][a-zA-Z0-9_]*)(?:\[([0-9]+)\]\.([a-zA-Z][a-zA-Z0-9_]*))?\}/g

/** Collect references in one string (whole-string and interpolated). */
function collectStringRefs(value: string, out: DagRef[]): void {
  REF_RE.lastIndex = 0
  let m = REF_RE.exec(value)
  while (m !== null) {
    const name = m[1]
    const field = m[2]
    if (name !== undefined && field !== undefined) {
      out.push({
        name,
        field,
        ...(m[3] === undefined ? {} : { index: Number(m[3]) }),
        ...(m[4] === undefined ? {} : { prop: m[4] }),
      })
    }
    m = REF_RE.exec(value)
  }
}

/** Collect every reference in a payload (strings, arrays, nested objects). */
export function collectDagRefs(value: unknown, out: DagRef[] = []): DagRef[] {
  if (typeof value === "string") {
    collectStringRefs(value, out)
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) collectDagRefs(item, out)
    return out
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectDagRefs(item, out)
  }
  return out
}

export interface DagNodeHooks<TOutcome> {
  /** Execute one node; returns its outcome for later references. */
  run: (name: string) => Promise<TOutcome>
  /** Report a node's progress line. */
  onProgress?: (name: string, done: number, total: number) => void
  /** Label a skipped node (its payload, for the skipped report). */
  skipPayload: (name: string) => Record<string, unknown>
}

export interface DagRunResult<TOutcome> {
  /** Completed outcomes by node name. */
  outcomes: Map<string, TOutcome>
  skipped: Array<{
    key: string
    payload: Record<string, unknown>
    reason: "aborted" | "not-started"
  }>
}

/** Edges for the DAG: every reference in a node's payload names a dependency. */
export function dagEdges(names: string[], payloadOf: (name: string) => unknown): DependencyList {
  const nameSet = new Set(names)
  const edges: DependencyList = []
  for (const name of names) {
    for (const ref of collectDagRefs(payloadOf(name))) {
      if (nameSet.has(ref.name) && ref.name !== name) edges.push([ref.name, name])
    }
  }
  return edges
}

export async function runDag<TOutcome>(
  names: string[],
  payloadOf: (name: string) => unknown,
  hooks: DagNodeHooks<TOutcome>,
  opts: { concurrency: number; signal?: AbortSignal | undefined },
): Promise<DagRunResult<TOutcome>> {
  const edges = dagEdges(names, payloadOf)
  const outcomes = new Map<string, TOutcome>()
  const skipped: DagRunResult<TOutcome>["skipped"] = []
  let failed = false
  const aborted = () => opts.signal?.aborted === true

  const nodes: PGraphNodeMap = new Map(
    names.map((name, i) => [
      name,
      {
        priority: -i,
        run: async () => {
          if (aborted() || failed) {
            skipped.push({ key: name, payload: hooks.skipPayload(name), reason: "aborted" })
            return
          }
          hooks.onProgress?.(name, outcomes.size + 1, names.length)
          outcomes.set(name, await hooks.run(name))
        },
      },
    ]),
  )

  try {
    await new PGraph(nodes, edges).run({
      ...(opts.concurrency > 0 ? { concurrency: opts.concurrency } : {}),
    })
  } catch (e) {
    failed = true
    const first = e instanceof PGraphError ? (e.taskErrors[0] ?? e) : e
    for (const name of names) {
      if (!outcomes.has(name)) {
        skipped.push({
          key: name,
          payload: hooks.skipPayload(name),
          reason: aborted() ? "aborted" : "not-started",
        })
      }
    }
    throw first
  }

  return { outcomes, skipped }
}
