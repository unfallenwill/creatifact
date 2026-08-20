import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test } from "vitest"
import { runBuild } from "../build"
import { MANIFEST_MEDIA_TYPE, readIndexEntries, upsertStoreEntry, withIndexLock } from "../oci"
import { listStoreEntries, removeStoreRefs, tagStoreRef } from "../store"

let dir: string
let configDir: string
let configPath: string
const assets = () => {
  const a = join(dir, "assets")
  mkdirSync(a, { recursive: true })
  writeFileSync(join(a, "a.txt"), "same-content")
  return a
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "store-test-"))
  configDir = join(dir, "cfg")
  configPath = join(configDir, "config.json")
  mkdirSync(configDir, { recursive: true })
  writeFileSync(configPath, JSON.stringify({ version: 1 }))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test("rm removes only the tag; shared blobs survive, last rm GCs them", async () => {
  // two builds of the same content → identical blobs, two tags
  const a = assets()
  await runBuild({
    tag: "x:1",
    assetsDir: a,
    output: undefined,
    annotations: {},
    from: [],
    copy: [],
    plainHttp: false,
    username: undefined,
    password: undefined,
    configPath,
  })
  await runBuild({
    tag: "y:1",
    assetsDir: a,
    output: undefined,
    annotations: {},
    from: [],
    copy: [],
    plainHttp: false,
    username: undefined,
    password: undefined,
    configPath,
  })
  const store = join(configDir, "store")
  const blobCount = () => readdirSync(join(store, "blobs", "sha256")).length
  const total = blobCount()

  // rm x:1 → y:1 still references everything: no blob deleted
  const first = await removeStoreRefs(["x:1"], configPath)
  expect(first.untagged).toEqual(["x:1"])
  expect(first.deletedBlobs).toEqual([])
  expect(blobCount()).toBe(total)
  expect((await listStoreEntries(configPath)).map((e) => e.ref)).toEqual(["y:1"])

  // rm y:1 → nothing references the blobs: all collected
  const second = await removeStoreRefs(["y:1"], configPath)
  expect(second.deletedBlobs.length).toBe(total)
  expect(blobCount()).toBe(0)
  expect(await listStoreEntries(configPath)).toEqual([])
})

test("rm of an unknown tag fails without touching the store", async () => {
  const a = assets()
  await runBuild({
    tag: "x:1",
    assetsDir: a,
    output: undefined,
    annotations: {},
    from: [],
    copy: [],
    plainHttp: false,
    username: undefined,
    password: undefined,
    configPath,
  })
  const store = join(configDir, "store")
  const before = readdirSync(join(store, "blobs", "sha256")).length
  await expect(removeStoreRefs(["nope:1"], configPath)).rejects.toThrow(/not found in store/)
  expect(readdirSync(join(store, "blobs", "sha256")).length).toBe(before)
  expect(existsSync(join(store, "index.json"))).toBe(true)
})

test("listStoreEntries is empty for a fresh store", async () => {
  expect(await listStoreEntries(configPath)).toEqual([])
  expect(readFileSync(configPath, "utf8")).toContain("version")
})

test("tag points a second ref at the same manifest without copying blobs", async () => {
  const a = assets()
  await runBuild({
    tag: "x:1",
    assetsDir: a,
    output: undefined,
    annotations: {},
    from: [],
    copy: [],
    plainHttp: false,
    username: undefined,
    password: undefined,
    configPath,
  })
  const store = join(configDir, "store")
  const total = readdirSync(join(store, "blobs", "sha256")).length

  const result = await tagStoreRef("x:1", "reg.example/x:1", configPath)
  expect(result).toEqual({ source: "x:1", target: "reg.example/x:1" })

  // Same digest under both refs; no blob added or copied.
  const entries = await listStoreEntries(configPath)
  const digests = new Set(entries.map((e) => e.digest))
  expect(entries.map((e) => e.ref).sort()).toEqual(["reg.example/x:1", "x:1"])
  expect(digests.size).toBe(1)
  expect(readdirSync(join(store, "blobs", "sha256")).length).toBe(total)

  // rm the alias: the original survives, shared blobs are not collected.
  await removeStoreRefs(["reg.example/x:1"], configPath)
  expect((await listStoreEntries(configPath)).map((e) => e.ref)).toEqual(["x:1"])
  expect(readdirSync(join(store, "blobs", "sha256")).length).toBe(total)
})

test("tag fails for unknown source or existing target", async () => {
  await expect(tagStoreRef("nope:1", "a:1", configPath)).rejects.toThrow(
    /tag 'nope:1' not found in store/,
  )
  const a = assets()
  for (const tag of ["x:1", "y:1"]) {
    await runBuild({
      tag,
      assetsDir: a,
      output: undefined,
      annotations: {},
      from: [],
      copy: [],
      plainHttp: false,
      username: undefined,
      password: undefined,
      configPath,
    })
  }
  await expect(tagStoreRef("x:1", "y:1", configPath)).rejects.toThrow(
    /tag 'y:1' already exists in store/,
  )
  expect((await listStoreEntries(configPath)).map((e) => e.ref).sort()).toEqual(["x:1", "y:1"])
})

test("concurrent store upserts do not lose index entries", async () => {
  // Eight parallel upserts into one shared store: every tag must survive.
  // Before the index lock this raced read-modify-write and dropped entries.
  const store = join(configDir, "store")
  const N = 8
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      upsertStoreEntry(
        store,
        {
          mediaType: MANIFEST_MEDIA_TYPE,
          digest: `sha256:${String(i).padStart(64, "0")}`,
          size: 1,
        },
        `race:${i}`,
      ),
    ),
  )
  const entries = await readIndexEntries(store)
  const tags = entries.map((e) => e.annotations?.["org.opencontainers.image.ref.name"])
  expect(entries).toHaveLength(N)
  for (let i = 0; i < N; i++) expect(tags).toContain(`race:${i}`)
})

test("store lock releases on failure", async () => {
  // A throwing critical section must release the lock (finally), or every
  // later store write would block until the lock goes stale.
  const store = join(configDir, "store")
  await expect(
    withIndexLock(store, async () => {
      throw new Error("boom")
    }),
  ).rejects.toThrow("boom")
  // Still lockable immediately afterwards.
  await withIndexLock(store, async () => {
    expect(true).toBe(true)
  })
})
