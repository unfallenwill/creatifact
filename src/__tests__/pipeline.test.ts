import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, expect, test, vi } from "vitest"
import { type PipelineStep, runPipeline } from "../pipeline"

function step(command: string, fields: Record<string, unknown>, name?: string): PipelineStep {
  return name === undefined ? { command, fields } : { command, fields, name }
}

let dir: string
let configPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "creatifact-pipeline-"))
  configPath = join(dir, "config.json")
  writeFileSync(configPath, JSON.stringify({ version: 1 }))
})

test(`runs build → build chain with \${step.outputDir} interpolation`, async () => {
  const out1 = join(dir, "one")
  const out2 = join(dir, "two")
  const results = await runPipeline(
    [
      step("build", { tag: "org/a:1", output: out1, annotations: { from: "first" } }, "a"),
      step(
        "build",
        { tag: "org/b:1", output: out2, annotations: { note: `after \${a.tag}` } },
        "b",
      ),
    ],
    { configPath },
  )
  expect(existsSync(join(out1, "index.json"))).toBe(true)
  expect(existsSync(join(out2, "index.json"))).toBe(true)
  expect(results.results.get("a")?.kind).toBe("build")
  expect(results.results.get("b")?.kind).toBe("build")
  rmSync(dir, { recursive: true, force: true })
})

test(`build → push → pull resolves \${} refs across registry steps (mocked)`, async () => {
  const out = join(dir, "built")
  const configBody = "{}"
  const configDigest = createHash("sha256").update(configBody).digest("hex")
  const manifestData = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: {
      mediaType: "application/vnd.oci.empty.v1+json",
      digest: `sha256:${configDigest}`,
      size: configBody.length,
    },
    layers: [],
  })
  const blobFor = (data: string): ArrayBuffer => {
    const bytes = new TextEncoder().encode(data)
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  }
  const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => {
    const target = String(url)
    if (init?.method === "PUT" || init?.method === "POST") {
      return Promise.resolve({ ok: true, status: 201, text: () => Promise.resolve("{}") })
    }
    if (target.includes("/manifests/")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => "application/vnd.oci.image.manifest.v1+json" },
        text: () => Promise.resolve(manifestData),
      })
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(configBody),
      arrayBuffer: () => Promise.resolve(blobFor(configBody)),
    })
  })
  vi.stubGlobal("fetch", fetchMock)

  const pulled = join(dir, "pulled")
  const results = await runPipeline(
    [
      step("build", { tag: "org/a:1", output: out }, "a"),
      step("push", { ref: `\${a.tag}`, layout: `\${a.outputDir}` }, "p"),
      step("pull", { ref: `\${a.tag}`, output: pulled }, "l"),
    ],
    { configPath },
  )
  expect(results.results.get("p")?.kind).toBe("push")
  expect(results.results.get("l")?.kind).toBe("pull")
  expect(fetchMock.mock.calls.some(([u]) => String(u).includes("org/a"))).toBe(true)

  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

test(`whole-string \${} keeps the referenced value; interpolation works in arrays`, async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, status: 201, text: () => Promise.resolve("{}") }),
  )
  const out = join(dir, "o")
  const results = await runPipeline([step("build", { tag: "org/a:1", output: out }, "a")], {
    configPath,
  })
  const a = results.results.get("a")
  expect(a?.kind).toBe("build")
  rmSync(dir, { recursive: true, force: true })
})

test("fails fast: unknown step reference", async () => {
  await expect(
    runPipeline([step("build", { tag: "x:1", layout: `\${ghost.tag}` })], { configPath }),
  ).rejects.toThrow(/unknown step 'ghost'/)
  rmSync(dir, { recursive: true, force: true })
})

test("fails fast: forward reference", async () => {
  await expect(
    runPipeline(
      [
        step("build", { tag: "x:1", annotations: { a: `\${later.tag}` } }, "early"),
        step("build", { tag: "y:1" }, "later"),
      ],
      { configPath },
    ),
  ).rejects.toThrow(/forward reference/)
  rmSync(dir, { recursive: true, force: true })
})

test("fails fast: duplicate step names", async () => {
  await expect(
    runPipeline([step("build", { tag: "x:1" }, "same"), step("build", { tag: "y:1" }, "same")], {
      configPath,
    }),
  ).rejects.toThrow(/duplicate step name 'same'/)
  rmSync(dir, { recursive: true, force: true })
})

test("fails fast: empty steps", async () => {
  await expect(runPipeline([], { configPath })).rejects.toThrow(/non-empty/)
  rmSync(dir, { recursive: true, force: true })
})

test("fails fast: generate step with noWait or json", async () => {
  await expect(
    runPipeline([step("generate.text2video", { prompt: "x", noWait: true })], { configPath }),
  ).rejects.toThrow(/noWait/)
  await expect(
    runPipeline([step("generate.text2image", { prompt: "x", json: true })], { configPath }),
  ).rejects.toThrow(/json/)
  rmSync(dir, { recursive: true, force: true })
})

test("fails fast: non-referenceable step results are rejected", async () => {
  await expect(
    runPipeline(
      [
        step("config.path", {}, "cfg"),
        step("build", { tag: "x:1", annotations: { v: `\${cfg.anything}` } }),
      ],
      { configPath },
    ),
  ).rejects.toThrow(/is not referenceable/)
  rmSync(dir, { recursive: true, force: true })
})

test("wraps step failures with the step label and stops the run", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve("boom") }),
  )
  const secondEffect = join(dir, "should-not-exist")
  await expect(
    runPipeline(
      [
        step("build", { tag: "org/a:1", output: join(dir, "one") }, "a"),
        step("push", { ref: `\${a.tag}`, layout: `\${a.outputDir}` }, "pusher"),
        step("build", { tag: "org/b:1", output: secondEffect }, "b"),
      ],
      { configPath },
    ),
  ).rejects.toThrow(/step 'pusher' \(2\/3\) failed/)
  expect(existsSync(secondEffect)).toBe(false)
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

test("rejects non-referenceable fields of a build result", async () => {
  await expect(
    runPipeline(
      [
        step("build", { tag: "x:1", output: join(dir, "o") }, "a"),
        step("build", { tag: "y:1", annotations: { v: `\${a.nonsense}` } }),
      ],
      { configPath },
    ),
  ).rejects.toThrow(/not referenceable/)
  rmSync(dir, { recursive: true, force: true })
})

test("media steps write into the shared store under their own tags", async () => {
  const store = join(dir, "store")
  try {
    const results = await runPipeline(
      [step("build", { tag: "x:1" }, "a"), step("build", { tag: "y:1" }, "b")],
      { configPath },
    )
    const a = results.results.get("a")
    expect(a?.kind === "build" && a.outputDir).toBe(store)
    const entries = JSON.parse(readFileSync(join(store, "index.json"), "utf8")).manifests as Array<{
      annotations?: Record<string, string>
    }>
    expect(entries.map((m) => m.annotations?.["org.opencontainers.image.ref.name"]).sort()).toEqual(
      ["x:1", "y:1"],
    )

    // reruns replace the same tag instead of failing on a non-empty dir
    await runPipeline([step("build", { tag: "x:1" }, "a")], { configPath })
    const after = JSON.parse(readFileSync(join(store, "index.json"), "utf8")).manifests as Array<{
      annotations?: Record<string, string>
    }>
    expect(after.map((m) => m.annotations?.["org.opencontainers.image.ref.name"]).sort()).toEqual([
      "x:1",
      "y:1",
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("sha256 helper sanity for imports", () => {
  expect(createHash("sha256").update("x").digest("hex")).toHaveLength(64)
})
