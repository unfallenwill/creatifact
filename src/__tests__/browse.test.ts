import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execa } from "execa"
import { okAsync } from "neverthrow"
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest"
import { type BrowserServer, startStoreBrowserServer } from "../browse"
import { runBuild } from "../build"
import { buildResultPackage, type RunSpec } from "../runPackage"
import { listStoreEntries, removeStoreRefs } from "../store"

const RUN_REF = "demo/crane:v1"

let dir: string
let configPath: string
let server: BrowserServer | undefined

// The SPA shell is a build artifact (vite + vite-plugin-singlefile); build it
// on demand so a fresh clone passes tests, mirroring cli.test.ts's dist boot.
beforeAll(async () => {
  if (!existsSync(new URL("../browserui/app.html", import.meta.url))) {
    await execa("npm", ["run", "build:ui"], { stdio: "inherit" })
    await execa("node", ["scripts/emit-ui.mjs"], { stdio: "inherit" })
  }
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "browse-test-"))
  const configDir = join(dir, "cfg")
  mkdirSync(configDir, { recursive: true })
  configPath = join(configDir, "config.json")
  writeFileSync(configPath, JSON.stringify({ version: 1 }))
})

afterEach(async () => {
  await server?.close()
  server = undefined
  rmSync(dir, { recursive: true, force: true })
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function start(): Promise<string> {
  server = await startStoreBrowserServer({
    configPath,
    removeRefs: (refs) => removeStoreRefs(refs, configPath),
  })
  return server.url
}

const runRefUrl = (base: string): string => `${base}/api/packages/${encodeURIComponent(RUN_REF)}`

async function addRunPackage(tag: string, task: RunSpec["task"]): Promise<void> {
  await buildResultPackage({
    outputDir: join(dir, "cfg", "store"),
    tag,
    store: true,
    fetchBytes: () => okAsync(Buffer.from("PNGDATA")),
    artifacts: [{ url: "https://cdn.test/crane.png", mimeType: "image/png" }],
    spec: {
      task,
      provider: "demo-pro",
      model: "crane-x",
      prompt: "a crane at dusk",
    },
    createdAt: "2026-08-17T00:00:00.000Z",
  })
}

test("/ serves the prebuilt SPA shell", async () => {
  const base = await start()
  const res = await fetch(base)
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toContain("text/html")
  const html = await res.text()
  expect(html).toContain('id="app"')
})

test("/api/packages reflects store entries with run summary and cover", async () => {
  await addRunPackage(RUN_REF, "text2image")
  const base = await start()

  const res = await fetch(`${base}/api/packages`)
  expect(res.status).toBe(200)
  const entries = (await res.json()) as Array<{
    ref: string
    digest: string
    kind: string
    cover?: string
    run?: { task: string; provider?: string; model?: string; createdAt?: string }
  }>
  expect(entries).toHaveLength(1)
  expect(entries[0]?.ref).toBe(RUN_REF)
  expect(entries[0]?.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
  expect(entries[0]?.kind).toBe("run")
  expect(entries[0]?.run).toMatchObject({
    task: "text2image",
    provider: "demo-pro",
    model: "crane-x",
    createdAt: "2026-08-17T00:00:00.000Z",
  })
  expect(entries[0]?.cover).toBe(
    `/package/${encodeURIComponent(RUN_REF)}/file/${encodeURIComponent("artifact-1.png")}`,
  )
})

test("/api/packages/:ref returns detail with run recipe, result, and files", async () => {
  await addRunPackage(RUN_REF, "text2image")
  const base = await start()

  const res = await fetch(runRefUrl(base))
  expect(res.status).toBe(200)
  const detail = (await res.json()) as {
    ref: string
    kind: string
    run?: { prompt?: string }
    files: Array<{ path: string; type: string; size?: number }>
  }
  expect(detail.ref).toBe(RUN_REF)
  expect(detail.kind).toBe("run")
  expect(detail.run?.prompt).toBe("a crane at dusk")
  expect(detail.files).toContainEqual({ path: "artifact-1.png", type: "file", size: 7 })
})

test("file endpoint serves exact bytes with the mapped content type", async () => {
  await addRunPackage(RUN_REF, "text2image")
  const base = await start()

  const res = await fetch(
    `${base}/package/${encodeURIComponent(RUN_REF)}/file/${encodeURIComponent("artifact-1.png")}`,
  )
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toBe("image/png")
  expect(Buffer.from(await res.arrayBuffer()).toString("utf8")).toBe("PNGDATA")
})

test("unknown packages, missing files, and traversal paths are 404 JSON", async () => {
  await addRunPackage(RUN_REF, "text2image")
  const base = await start()

  const unknownPkg = await fetch(`${base}/api/packages/${encodeURIComponent("nope:v1")}`)
  expect(unknownPkg.status).toBe(404)
  expect(await unknownPkg.json()).toEqual({ error: "package not in store" })

  expect(
    (
      await fetch(
        `${base}/package/${encodeURIComponent(RUN_REF)}/file/${encodeURIComponent("../config.json")}`,
      )
    ).status,
  ).toBe(404)
  expect((await fetch(`${runRefUrl(base)}/file/missing.txt`)).status).toBe(404)
  expect((await fetch(`${base}/no/such/path`)).status).toBe(404)
})

test("DELETE untags, keeps shared blobs, and GCs the last reference", async () => {
  // same artifact bytes → shared layer blob; different tasks → distinct manifests
  await addRunPackage("demo/a:v1", "text2image")
  await addRunPackage("demo/b:v1", "image2image")
  const base = await start()

  const first = await fetch(`${base}/api/packages/${encodeURIComponent("demo/a:v1")}`, {
    method: "DELETE",
  })
  expect(first.status).toBe(200)
  // a:v1's own manifest + config blobs become unreachable and are collected;
  // the shared artifact layer survives — proven by b:v1 still serving below.
  const firstBody = (await first.json()) as { untagged: string[]; deletedBlobs: string[] }
  expect(firstBody).toEqual({ untagged: ["demo/a:v1"], deletedBlobs: expect.any(Array) })
  expect(firstBody.deletedBlobs).toHaveLength(2)

  const remaining = (await (await fetch(`${base}/api/packages`)).json()) as Array<{ ref: string }>
  expect(remaining.map((e) => e.ref)).toEqual(["demo/b:v1"])
  expect(
    (
      await fetch(
        `${base}/package/${encodeURIComponent("demo/b:v1")}/file/${encodeURIComponent("artifact-1.png")}`,
      )
    ).status,
  ).toBe(200)

  const second = await fetch(`${base}/api/packages/${encodeURIComponent("demo/b:v1")}`, {
    method: "DELETE",
  })
  const body = (await second.json()) as { untagged: string[]; deletedBlobs: string[] }
  expect(body).toEqual({ untagged: ["demo/b:v1"], deletedBlobs: expect.any(Array) })
  expect(body.deletedBlobs.length).toBeGreaterThan(0)
  expect(await listStoreEntries(configPath)).toEqual([])

  const gone = await fetch(`${base}/api/packages/${encodeURIComponent("demo/b:v1")}`, {
    method: "DELETE",
  })
  expect(gone.status).toBe(404)
})

test("empty store lists no packages", async () => {
  const base = await start()
  expect(await (await fetch(`${base}/api/packages`)).json()).toEqual([])
})

test("plain image packages list as image kind and serve their layer files", async () => {
  const assets = join(dir, "assets")
  mkdirSync(assets)
  writeFileSync(join(assets, "a.txt"), "same-content")
  await runBuild({
    tag: "assets:1",
    assetsDir: assets,
    output: undefined,
    annotations: {},
    from: [],
    copy: [],
    plainHttp: false,
    username: undefined,
    password: undefined,
    configPath,
  })
  const base = await start()

  const entries = (await (await fetch(`${base}/api/packages`)).json()) as Array<{
    ref: string
    kind: string
    run?: unknown
    cover?: string
  }>
  expect(entries).toHaveLength(1)
  expect(entries[0]?.ref).toBe("assets:1")
  expect(entries[0]?.kind).toBe("image")
  expect(entries[0]?.run).toBeUndefined()
  expect(entries[0]?.cover).toBeUndefined()

  const res = await fetch(
    `${base}/package/${encodeURIComponent("assets:1")}/file/${encodeURIComponent("a.txt")}`,
  )
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8")
  expect(await res.text()).toBe("same-content")
})
