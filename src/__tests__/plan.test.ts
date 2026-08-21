import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  fingerprintStage,
  hashAssetsDir,
  planDigestOf,
  type StageInputs,
  stageDependencies,
  topoOrder,
} from "../plan"

/**
 * Plan primitives: fingerprints must be stable across filesystem entry
 * order and insensitive to key order/whitespace in manifests, and must
 * change exactly when a resolved input changes. Topology derivation covers
 * chains, fan-in, and cycle rejection.
 */
const ref = (name: string, field: string): string => `\${${name}.${field}}`

test("hashAssetsDir is stable across entry order and covers dotfiles", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "plan-assets-"))
  const a = join(tmp, "a")
  const b = join(tmp, "b")
  await mkdir(a, { recursive: true })
  await mkdir(join(a, "sub"), { recursive: true })
  await writeFile(join(a, "z.txt"), "z")
  await writeFile(join(a, ".hidden"), "h")
  await writeFile(join(a, "sub", "x.txt"), "x")
  await mkdir(b, { recursive: true })
  await mkdir(join(b, "sub"), { recursive: true })
  // Same content, created in a different order.
  await writeFile(join(b, "sub", "x.txt"), "x")
  await writeFile(join(b, ".hidden"), "h")
  await writeFile(join(b, "z.txt"), "z")

  try {
    expect(await hashAssetsDir(a)).toBe(await hashAssetsDir(b))
    // Content change flips the digest.
    await writeFile(join(a, "z.txt"), "z2")
    expect(await hashAssetsDir(a)).not.toBe(await hashAssetsDir(b))
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test("fingerprintStage changes exactly with each resolved input", () => {
  const base = (): StageInputs => ({
    defaultProvider: "zhipu",
    run: { task: "text2image", prompt: "a crane" },
    from: [{ from: "localhost:5000/base:1.0", digest: "sha256:aaa" }],
    copy: [{ from: "localhost:5000/cuda:12.0", digest: "sha256:bbb", paths: ["libs"] }],
    assets: "sha256:ccc",
    annotations: { k: "v" },
  })
  const d0 = fingerprintStage(base())

  // Key order and insertion order are irrelevant (stableStringify sorts).
  const reordered: StageInputs = {
    ...base(),
    run: { prompt: "a crane", task: "text2image" },
  }
  expect(fingerprintStage(reordered)).toBe(d0)

  // Each input dimension moves the digest.
  expect(fingerprintStage({ ...base(), run: { task: "text2image", prompt: "a dog" } })).not.toBe(d0)
  expect(fingerprintStage({ ...base(), defaultProvider: "ark" })).not.toBe(d0)
  expect(
    fingerprintStage({
      ...base(),
      from: [{ from: "localhost:5000/base:1.0", digest: "sha256:zzz" }],
    }),
  ).not.toBe(d0)
  expect(fingerprintStage({ ...base(), assets: "sha256:ddd" })).not.toBe(d0)
  expect(fingerprintStage({ ...base(), annotations: { k: "v2" } })).not.toBe(d0)
})

test("topoOrder orders chains and fan-ins, and rejects cycles", () => {
  const payload: Record<string, unknown> = {
    a: { gen: { task: "text2image" } },
    b: { annotations: { x: ref("a", "digest") } },
    c: { annotations: { x: ref("a", "digest"), y: ref("b", "digest") } },
    d: {},
  }
  const names = ["a", "b", "c", "d"]
  const order = topoOrder(names, (n) => payload[n] ?? {})
  const idx = new Map(order.map((n, i) => [n, i]))
  expect((idx.get("a") ?? 0) < (idx.get("b") ?? 1)).toBe(true)
  expect((idx.get("b") ?? 0) < (idx.get("c") ?? 1)).toBe(true)
  expect((idx.get("a") ?? 0) < (idx.get("c") ?? 1)).toBe(true)

  const cyclic = {
    a: { annotations: { x: ref("b", "digest") } },
    b: { annotations: { x: ref("a", "digest") } },
  }
  expect(() => topoOrder(["a", "b"], (n) => cyclic[n as keyof typeof cyclic] ?? {})).toThrow(
    "cycle",
  )
})

test("stageDependencies collects direct dependencies per stage", () => {
  const payload: Record<string, unknown> = {
    a: {},
    b: { annotations: { x: ref("a", "tag") } },
    c: { copy: [{ from: ref("b", "tag"), paths: ["x"] }] },
  }
  const deps = stageDependencies(["a", "b", "c"], (n) => payload[n] ?? {})
  expect(deps.get("a")).toEqual([])
  expect(deps.get("b")).toEqual(["a"])
  expect(deps.get("c")).toEqual(["b"])
})

test("planDigestOf is stable and content-addressed", () => {
  const stages = [
    { name: "a", inputsDigest: "sha256:aaa", dependencies: [] },
    { name: "b", inputsDigest: "sha256:bbb", dependencies: ["a"] },
  ]
  const d1 = planDigestOf(stages, "org/x:1")
  const d2 = planDigestOf(
    [
      { name: "b", inputsDigest: "sha256:bbb", dependencies: ["a"] },
      { name: "a", inputsDigest: "sha256:aaa", dependencies: [] },
    ],
    "org/x:1",
  )
  expect(d1).toBe(d2)
  expect(planDigestOf(stages, "org/x:2")).not.toBe(d1)
  expect(
    planDigestOf([{ name: "a", inputsDigest: "sha256:zzz", dependencies: [] }], "org/x:1"),
  ).not.toBe(d1)
})
