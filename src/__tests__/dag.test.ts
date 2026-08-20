import { collectDagRefs, type DagRef, dagEdges } from "../dag"

/**
 * The DAG engine tests: reference collection and edge derivation — the two
 * halves of "users declare stages + references; the scheduler derives the
 * plan". Execution semantics (concurrency, fail-fast, skip reporting) are
 * covered end to end by the build-stages and -f integration tests.
 *
 * Ref fixtures build `${...}` via concatenation so the source itself never
 * carries a template-literal-looking string.
 */
const ref = (name: string, field: string): string => `\${${name}.${field}}`
const indexedRef = (name: string, field: string, index: number, prop: string): string =>
  `\${${name}.${field}[${index}].${prop}}`

test("collectDagRefs finds whole-string and interpolated refs", () => {
  const refs = collectDagRefs({
    a: ref("cat", "tag"),
    b: `prefix ${indexedRef("cat", "artifacts", 0, "url")} suffix`,
    list: [ref("dog", "digest"), "plain"],
    nested: { deep: ref("combo", "outputDir") },
    n: 42,
  })
  const keys = refs.map(refKey).sort()
  expect(keys).toEqual(["cat.artifacts[0].url", "cat.tag", "combo.outputDir", "dog.digest"])
})

test("collectDagRefs returns empty for no refs", () => {
  expect(collectDagRefs({ a: "x", b: ["y", 1], c: { d: null } })).toEqual([])
})

test("dagEdges: every reference in a node's payload is an edge", () => {
  const payload = {
    a: { gen: { task: "text2image" } },
    b: { annotations: { x: ref("a", "tag") } },
    c: { gen: { images: [indexedRef("a", "artifacts", 0, "url"), ref("b", "digest")] } },
    d: { assets: "." },
  }
  const edges = dagEdges(["a", "b", "c", "d"], (n) => payload[n as keyof typeof payload] ?? {})
  expect(edges.sort()).toEqual(
    [
      ["a", "b"],
      ["a", "c"],
      ["b", "c"],
    ].sort(),
  )
})

test("dagEdges: self-references and unknown names are not edges", () => {
  const payload = {
    a: { x: ref("a", "tag") }, // self → no edge
    b: { x: ref("nope", "tag") }, // unknown → not a node
  }
  expect(dagEdges(["a", "b"], (n) => payload[n as keyof typeof payload] ?? {})).toEqual([])
})

/** Stable key form of a ref for assertions. */
function refKey(r: DagRef): string {
  return r.index === undefined
    ? `${r.name}.${r.field}`
    : `${r.name}.${r.field}[${r.index}].${r.prop}`
}
