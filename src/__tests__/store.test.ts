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
import { listStoreEntries, removeStoreRefs } from "../store"

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
