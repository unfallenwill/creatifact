import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable, Writable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createGzip, gunzipSync } from "node:zlib"
import { extract, pack } from "tar-stream"
import {
  applyTarLayer,
  createLayerFromView,
  type FsEntry,
  type FsView,
  mergeImageLayers,
  normalizeTarPath,
  selectPaths,
} from "../layers"

interface FixtureEntry {
  name: string
  type?: "file" | "directory" | "symlink" | "link"
  data?: string
  linkname?: string
  mode?: number
}

async function makeLayer(entries: FixtureEntry[]): Promise<Buffer> {
  const tarPack = pack()
  for (const e of entries) {
    if (e.type === "directory") {
      tarPack.entry({ name: e.name, type: "directory", mode: e.mode ?? 0o755 })
    } else if (e.type === "symlink" || e.type === "link") {
      tarPack.entry({ name: e.name, type: e.type, linkname: e.linkname ?? "" })
    } else {
      tarPack.entry(
        { name: e.name, size: (e.data ?? "").length, mode: e.mode ?? 0o644 },
        e.data ?? "",
      )
    }
  }
  tarPack.finalize()

  const chunks: Buffer[] = []
  const collector = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
  })
  await pipeline(tarPack, createGzip(), collector)
  return Buffer.concat(chunks)
}

async function extractEntries(layerGz: Buffer): Promise<Map<string, string>> {
  const entries = new Map<string, string>()
  const extractor = extract()
  const done = pipeline(Readable.from([gunzipSync(layerGz)]), extractor)
  for await (const entry of extractor) {
    const chunks: Buffer[] = []
    for await (const chunk of entry) chunks.push(Buffer.from(chunk))
    entries.set(entry.header.name, Buffer.concat(chunks).toString("utf8"))
  }
  await done
  return entries
}

function collectFiles(view: FsView): string[] {
  return [...view.keys()].sort()
}

function newView(): FsView {
  return new Map<string, FsEntry>()
}

test("normalizeTarPath folds ./ and dot segments", () => {
  expect(normalizeTarPath("./a.txt")).toBe("a.txt")
  expect(normalizeTarPath("a//b.txt")).toBe("a/b.txt")
  expect(normalizeTarPath("a/./b")).toBe("a/b")
})

test("normalizeTarPath rejects traversal and absolute paths", () => {
  expect(normalizeTarPath("../evil")).toBeNull()
  expect(normalizeTarPath("a/../b")).toBeNull()
  expect(normalizeTarPath("/abs")).toBeNull()
  expect(normalizeTarPath("")).toBeNull()
  expect(normalizeTarPath("./")).toBeNull()
})

test("whiteout removes a file in the same layer", async () => {
  const layer = await makeLayer([{ name: "a.txt", data: "v1" }, { name: ".wh.a.txt" }])
  const view = newView()
  await applyTarLayer(view, layer, new Set())
  expect(view.has("a.txt")).toBe(false)
})

test("whiteout removes a file from a lower layer", async () => {
  const layer1 = await makeLayer([{ name: "a.txt", data: "v1" }])
  const layer2 = await makeLayer([{ name: ".wh.a.txt" }])
  const { view } = await mergeImageLayers([layer1, layer2])
  expect(view.has("a.txt")).toBe(false)
})

test("whiteout removes a directory subtree from a lower layer", async () => {
  const layer1 = await makeLayer([
    { name: "d/f.txt", data: "x" },
    { name: "d/sub/g.txt", data: "y" },
  ])
  const layer2 = await makeLayer([{ name: ".wh.d" }])
  const { view } = await mergeImageLayers([layer1, layer2])
  expect(view.has("d")).toBe(false)
  expect(view.has("d/f.txt")).toBe(false)
  expect(view.has("d/sub/g.txt")).toBe(false)
})

test("opaque marker clears lower layer directory then adds files", async () => {
  const layer1 = await makeLayer([{ name: "d/old.txt", data: "old" }])
  const layer2 = await makeLayer([{ name: "d/.wh..wh..opq" }, { name: "d/new.txt", data: "new" }])
  const { view } = await mergeImageLayers([layer1, layer2])
  expect(collectFiles(view)).toEqual(["d", "d/new.txt"])
  expect(view.has("d/old.txt")).toBe(false)
})

test("directory entries do not clobber existing children", async () => {
  const layer1 = await makeLayer([{ name: "d/f.txt", data: "x" }])
  const layer2 = await makeLayer([{ name: "d/", type: "directory" }])
  const { view } = await mergeImageLayers([layer1, layer2])
  const file = view.get("d/f.txt")
  expect(file?.type).toBe("file")
  expect(file?.type === "file" ? file.data : null).toEqual(Buffer.from("x"))
})

test("symlink and hardlink entries become symlinks", async () => {
  const layer = await makeLayer([
    { name: "s", type: "symlink", linkname: "target" },
    { name: "h", type: "link", linkname: "s" },
  ])
  const view = newView()
  await applyTarLayer(view, layer, new Set())
  expect(view.get("s")).toEqual({ type: "symlink", target: "target" })
  expect(view.get("h")).toEqual({ type: "symlink", target: "s" })
})

test("unsafe tar paths are skipped", async () => {
  const layer = await makeLayer([{ name: "../evil.txt", data: "x" }, { name: "/abs.txt" }])
  const view = newView()
  await applyTarLayer(view, layer, new Set())
  expect(collectFiles(view)).toEqual([])
})

test("later layers override same paths", async () => {
  const layer1 = await makeLayer([{ name: "a.txt", data: "v1" }])
  const layer2 = await makeLayer([{ name: "a.txt", data: "v2" }])
  const { view } = await mergeImageLayers([layer1, layer2])
  const file = view.get("a.txt")
  expect(file?.type).toBe("file")
  expect(file?.type === "file" ? file.data : null).toEqual(Buffer.from("v2"))
})

test("selectPaths matches exact files and subtree prefixes", async () => {
  const layer1 = await makeLayer([
    { name: "lib/x.so", data: "x" },
    { name: "lib/sub/y.so", data: "y" },
    { name: "bin/tool", data: "t" },
  ])
  const { view } = await mergeImageLayers([layer1])

  const { selected } = selectPaths(view, ["lib/x.so", "bin"], new Set())
  expect(collectFiles(selected)).toEqual(["bin/tool", "lib/x.so"])
})

test("selectPaths normalizes request paths with slashes", async () => {
  const layer1 = await makeLayer([{ name: "d/f.txt", data: "x" }])
  const { view } = await mergeImageLayers([layer1])

  const { selected } = selectPaths(view, ["d/"], new Set())
  expect(collectFiles(selected)).toEqual(["d/f.txt"])
})

test("selectPaths throws when a path has no match", async () => {
  const layer1 = await makeLayer([{ name: "a.txt", data: "x" }])
  const { view } = await mergeImageLayers([layer1])
  expect(() => selectPaths(view, ["nope"], new Set())).toThrow("not found")
})

test("selectPaths re-emits opaque markers for fully selected opaque dirs", async () => {
  const layer1 = await makeLayer([{ name: "d/old.txt", data: "old" }])
  const layer2 = await makeLayer([{ name: "d/.wh..wh..opq" }, { name: "d/new.txt", data: "new" }])
  const { view, opaqueDirs } = await mergeImageLayers([layer1, layer2])

  const { opaqueDirs: selectedOpaque } = selectPaths(view, ["d"], opaqueDirs)
  expect([...selectedOpaque]).toEqual(["d"])

  const noOpaque = selectPaths(view, ["d/new.txt"], opaqueDirs)
  expect(noOpaque.opaqueDirs.size).toBe(0)
})

test("createLayerFromView produces deterministic digests", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "layers-test-"))
  const blobsDir = join(tmp, "blobs", "sha256")
  await mkdir(blobsDir, { recursive: true })

  const { view } = await mergeImageLayers([
    await makeLayer([
      { name: "deep/nested/file.txt", data: "hello" },
      { name: "empty-dir/", type: "directory" },
    ]),
  ])

  const desc1 = await createLayerFromView(view, new Set(), blobsDir)
  const desc2 = await createLayerFromView(view, new Set(), blobsDir)

  expect(desc1.descriptor.digest).toBe(desc2.descriptor.digest)

  await rm(tmp, { recursive: true })
})

test("createLayerFromView synthesizes parents and re-emits opaque markers", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "layers-test-"))
  const blobsDir = join(tmp, "blobs", "sha256")
  await mkdir(blobsDir, { recursive: true })

  const { view } = await mergeImageLayers([
    await makeLayer([
      { name: "bin/tool", data: "tool-content", mode: 0o755 },
      { name: "d/.wh..wh..opq" },
      { name: "d/new.txt", data: "new" },
    ]),
  ])

  const desc = await createLayerFromView(view, new Set(["d"]), blobsDir)
  const blobData = await readFile(join(blobsDir, desc.descriptor.digest.slice(7)))
  const entries = await extractEntries(blobData)

  expect(entries.has("bin/")).toBe(true)
  expect(entries.has("d/")).toBe(true)
  expect(entries.get("d/.wh..wh..opq")).toBe("")
  expect(entries.get("d/new.txt")).toBe("new")
  expect(entries.get("bin/tool")).toBe("tool-content")

  await rm(tmp, { recursive: true })
})
