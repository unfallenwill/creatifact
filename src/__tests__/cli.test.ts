import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import { gunzipSync } from "node:zlib"
import { execa } from "execa"
import { stripAnsi } from "../format"
import { mergeImageLayers } from "../layers"
import { METADATA_FILE } from "../runPackage"

const CLI = path.resolve("dist/index.mjs")

beforeAll(async () => {
  if (!existsSync(CLI)) await execa("npm", ["run", "build"], { stdio: "inherit" })
})

// Async execa keeps the worker IPC loop free, so Vitest can flush task
// updates between cases — no afterEach yield needed anymore.

interface RunResult {
  stdout: string
  stderr: string
  code: number | null
}

async function run(
  args: string[],
  input?: string,
  env?: Record<string, string>,
  cwd?: string,
): Promise<RunResult> {
  const result = await execa(process.execPath, [CLI, ...args], {
    ...(input === undefined ? {} : { input }),
    reject: false,
    ...(cwd === undefined ? {} : { cwd }),
    // NO_COLOR pins most assertions to the contracted plain-text form so the
    // suite never depends on the host's ambient color heuristics (CI=true,
    // win32, a user's FORCE_COLOR). The color path itself is covered
    // explicitly by the dual-mode test below.
    ...(env === undefined ? {} : { env: { ...process.env, NO_COLOR: "1", ...env } }),
  })
  return { stdout: result.stdout, stderr: result.stderr, code: result.exitCode ?? null }
}

interface ErrEnvelope {
  ok: false
  error: { code: string; message: string; details?: Record<string, unknown> }
}

/** The envelope is the last non-empty stdout line (status lines go to stderr). */
function lastLine(stdout: string): string {
  return (
    stdout
      .trimEnd()
      .split("\n")
      .filter((l) => l !== "")
      .at(-1) ?? ""
  )
}

/** Parse a command's stderr as the unified error envelope and assert its code.
 * Progress/status lines may precede it on stderr; the envelope is always the
 * last non-empty line. */
function expectErr(r: RunResult, code: string, messageSub?: string): ErrEnvelope {
  const lastLine =
    r.stderr
      .trimEnd()
      .split("\n")
      .filter((l) => l !== "")
      .at(-1) ?? ""
  const envelope = JSON.parse(lastLine) as ErrEnvelope
  expect(envelope.ok).toBe(false)
  expect(envelope.error.code).toBe(code)
  if (messageSub !== undefined) expect(envelope.error.message).toContain(messageSub)
  return envelope
}

describe("cli — integration", () => {
  it("--version prints the package version and exits 0", async () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string }
    const { stdout, code } = await run(["--version"])
    expect(code).toBe(0)
    expect(stdout.trim()).toBe(pkg.version)
  })

  it("bare invocation prints usage and exits 0", async () => {
    const { stdout, code } = await run([])
    expect(code).toBe(0)
    expect(stdout).toContain("creatifact -f <file>.json")
    expect(stdout).toContain("run")
    expect(stdout).toContain("build")
    expect(stdout).toContain("auth")
    expect(stdout).toContain("config")
  })

  it("unknown command errors with a JSON envelope on stderr", async () => {
    const r = await run(["frobnicate"])
    expect(r.code).toBe(2)
    expectErr(r, "E_USAGE", "unknown command: frobnicate")
  })

  it("build/push/pull --help list options; unknown top-level fails", async () => {
    const build = await run(["build", "--help"])
    expect(build.code).toBe(0)
    expect(build.stdout).toContain("Usage: creatifact build")

    const auth = await run(["auth", "--help"])
    expect(auth.code).toBe(0)
    expect(auth.stdout).toContain("Usage: creatifact auth <action>")
    expect(auth.stdout).toContain("login")

    const unknown = await run(["frobnicate"])
    expect(unknown.code).toBe(2)
    expectErr(unknown, "E_USAGE")
  })
})

describe("cli build — integration", () => {
  it("build creates valid OCI layout", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "oci-cli-test-"))
    const fixtureDir = path.join(tmp, "fixture")
    const outputDir = path.join(tmp, "output")
    mkdirSync(fixtureDir, { recursive: true })
    writeFileSync(path.join(fixtureDir, "asset.txt"), "test asset content")

    try {
      const { stdout, stderr, code } = await run([
        "build",
        "--dir",
        fixtureDir,
        "-t",
        "test/fixture:1.0.0",
        "-o",
        outputDir,
      ])

      expect(code).toBe(0)
      expect(stdout.trimEnd()).toContain('"ok":true')
      expect(stderr).toContain("built test/fixture:1.0.0")
      expect(existsSync(path.join(outputDir, "oci-layout"))).toBe(true)
      expect(existsSync(path.join(outputDir, "index.json"))).toBe(true)
      expect(existsSync(path.join(outputDir, "blobs", "sha256"))).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("build --help prints usage and exits 0", async () => {
    const { stdout, code } = await run(["build", "--help"])
    expect(code).toBe(0)
    expect(stdout).toContain("Usage: creatifact build")
    expect(stdout).toContain("--tag")
    expect(stdout).toContain("--annotation")
    expect(stdout).toContain("--plain-http")
  })

  it("build -h prints usage and exits 0", async () => {
    const { stdout, code } = await run(["build", "-h"])
    expect(code).toBe(0)
    expect(stdout).toContain("Usage: creatifact build")
  })

  it("build fails when dir does not exist", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "oci-cli-test-"))
    try {
      const r = await run([
        "build",
        "--dir",
        "/nonexistent/path/xyz",
        "-t",
        "test:1.0",
        "-o",
        path.join(tmp, "out"),
      ])
      expect(r.code).toBe(2)
      expectErr(r, "E_USAGE", "does not exist")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("build fails when tag is missing", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "oci-cli-test-"))
    const fixtureDir = path.join(tmp, "fixture")
    mkdirSync(fixtureDir, { recursive: true })
    writeFileSync(path.join(fixtureDir, "file.txt"), "data")

    try {
      const { stderr, code } = await run(["build", "--dir", fixtureDir])
      expect(code).toBe(2)
      expectErr({ stdout: "", stderr, code } as RunResult, "E_USAGE", "--tag")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("build with manifest assets and CLI tag", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "oci-cli-test-"))
    const fixtureDir = path.join(tmp, "fixture")
    const outputDir = path.join(tmp, "output")
    mkdirSync(fixtureDir, { recursive: true })
    writeFileSync(path.join(fixtureDir, "asset.txt"), "from manifest")
    const descPath = path.join(tmp, "creatifact.json")
    writeFileSync(
      descPath,
      JSON.stringify({
        assets: fixtureDir,
        annotations: { "test.key": "test-value" },
      }),
    )

    try {
      const { stdout, code } = await run([
        "build",
        "-f",
        descPath,
        "-t",
        "desc/test:2.0.0",
        "-o",
        outputDir,
      ])

      expect(code).toBe(0)
      expect(stdout).toContain("desc/test:2.0.0")

      const index = JSON.parse(readFileSync(path.join(outputDir, "index.json"), "utf8"))
      expect(index.manifests[0].annotations["org.opencontainers.image.ref.name"]).toBe(
        "desc/test:2.0.0",
      )
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("build --dir overrides manifest assets", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "oci-cli-test-"))
    const manifestAssets = path.join(tmp, "manifest-assets")
    const cliAssets = path.join(tmp, "cli-assets")
    const outputDir = path.join(tmp, "output")
    mkdirSync(manifestAssets, { recursive: true })
    mkdirSync(cliAssets, { recursive: true })
    writeFileSync(path.join(manifestAssets, "manifest.txt"), "manifest content")
    writeFileSync(path.join(cliAssets, "cli.txt"), "cli content")
    const descPath = path.join(tmp, "creatifact.json")
    writeFileSync(descPath, JSON.stringify({ assets: manifestAssets }))

    try {
      const { code } = await run([
        "build",
        "-f",
        descPath,
        "-t",
        "test:1.0",
        "--dir",
        cliAssets,
        "-o",
        outputDir,
      ])
      expect(code).toBe(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("build inherits from a local OCI layout", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "oci-cli-test-"))
    const sourceDir = path.join(tmp, "source")
    const sourceLayout = path.join(tmp, "source-layout")
    const outputDir = path.join(tmp, "output")
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(path.join(sourceDir, "base.txt"), "base")

    try {
      const first = await run([
        "build",
        "-t",
        "org/source:1.0.0",
        "--dir",
        sourceDir,
        "-o",
        sourceLayout,
      ])
      expect(first.code, first.stderr).toBe(0)

      const descPath = path.join(tmp, "creatifact.json")
      writeFileSync(descPath, JSON.stringify({ from: sourceLayout }))
      const { code } = await run([
        "build",
        "-f",
        descPath,
        "-t",
        "org/combined:1.0.0",
        "-o",
        outputDir,
      ])
      expect(code).toBe(0)

      const index = JSON.parse(readFileSync(path.join(outputDir, "index.json"), "utf8"))
      const manifest = JSON.parse(
        readFileSync(
          path.join(outputDir, "blobs", "sha256", index.manifests[0].digest.slice(7)),
          "utf8",
        ),
      )
      expect(manifest.layers).toHaveLength(1)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("build warns about legacy manifest fields and still needs -t", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "oci-cli-test-"))
    const descPath = path.join(tmp, "creatifact.json")
    writeFileSync(descPath, JSON.stringify({ tag: "old/test:1.0", dir: "./x" }))

    try {
      const { stderr, code } = await run(["build", "-f", descPath])
      expect(code).toBe(2)
      expectErr({ stdout: "", stderr, code } as RunResult, "E_USAGE", "--tag is required")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("build reads a JSONC manifest (comments + trailing commas)", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "oci-cli-test-"))
    const assets = path.join(tmp, "assets")
    mkdirSync(assets, { recursive: true })
    writeFileSync(path.join(assets, "a.txt"), "a")
    const descPath = path.join(tmp, "creatifact.json")
    writeFileSync(
      descPath,
      `{
        // top layer
        "assets": "${assets}", /* inline note */
      }`,
    )

    try {
      const { stdout, code } = await run(["build", "-f", descPath, "-t", "jsonc:1.0"])
      expect(code, stdout).toBe(0)
      expect(JSON.parse(lastLine(stdout)).ok).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("build --plan inlines run.promptFile and never reports promptFile", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "oci-cli-test-"))
    writeFileSync(path.join(tmp, "prompt.md"), "a cat on a cliff\n")
    const descPath = path.join(tmp, "creatifact.json")
    writeFileSync(
      descPath,
      JSON.stringify({
        stages: [{ name: "cat", run: { task: "text2image", promptFile: "./prompt.md" } }],
      }),
    )

    try {
      const { stdout, stderr, code } = await run([
        "build",
        "-f",
        descPath,
        "-t",
        "promptfile:1.0",
        "--plan",
      ])
      expect(code, stderr).toBe(0)
      const envelope = JSON.parse(lastLine(stdout))
      expect(envelope.ok).toBe(true)
      expect(envelope.data.plan.stages).toEqual([
        {
          name: "cat",
          inputsDigest: expect.any(String),
          status: "would-execute",
          dependencies: [],
        },
      ])
      // promptFile never survives into the plan; the inlined prompt feeds the fingerprint
      expect(JSON.stringify(envelope)).not.toContain("promptFile")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("build loads ./creatifact.json from the working directory without -f", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "oci-cli-test-"))
    const assets = path.join(tmp, "assets")
    mkdirSync(assets, { recursive: true })
    writeFileSync(path.join(assets, "a.txt"), "a")
    writeFileSync(
      path.join(tmp, "creatifact.json"),
      `{
        // default manifest, no -f needed
        "assets": "./assets",
      }`,
    )

    try {
      const { stdout, stderr, code } = await run(
        ["build", "-t", "default:1.0"],
        undefined,
        undefined,
        tmp,
      )
      expect(code, stderr).toBe(0)
      expect(JSON.parse(lastLine(stdout)).ok).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe("cli push — integration", () => {
  it("push --help prints usage and exits 0", async () => {
    const { stdout, code } = await run(["push", "--help"])
    expect(code).toBe(0)
    expect(stdout).toContain("Usage: creatifact push")
    expect(stdout).toContain("--layout")
    expect(stdout).toContain("--plain-http")
  })

  it("push -h prints usage and exits 0", async () => {
    const { stdout, code } = await run(["push", "-h"])
    expect(code).toBe(0)
    expect(stdout).toContain("Usage: creatifact push")
  })

  it("push fails when layout directory does not exist", async () => {
    const r = await run([
      "push",
      "localhost:5000/test:1.0",
      "--layout",
      "/nonexistent/path/xyz",
      "--plain-http",
    ])
    expect(r.code).toBe(2)
    expectErr(r, "E_USAGE", "no image layout")
  })

  it("pull --help prints usage and exits 0", async () => {
    const { stdout, code } = await run(["pull", "--help"])
    expect(code).toBe(0)
    expect(stdout).toContain("Usage: creatifact pull")
  })
})

describe("cli models — custom declarations", () => {
  it("lists custom models with a marker; rejects unknown provider keys", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "cli-models-"))
    const configDir = path.join(tmp, "cfg")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        providers: { minimax: { apiKey: "k" } },
        models: {
          minimax: [
            {
              id: "MiniMax-H4",
              mode: "v2",
              capabilities: { "video.generate": { textOnly: true } },
              note: "next gen",
            },
            { id: "MiniMax-H3", note: "gw override" },
          ],
        },
      }),
    )
    const env = { CREATIFACT_CONFIG_DIR: configDir }
    try {
      const r = await run(["models", "minimax"], undefined, env)
      expect(r.code).toBe(0)
      const parsed = JSON.parse(r.stdout)
      expect(parsed.kind).toBe("models")
      const m4 = parsed.data.models.find((m: { id: string }) => m.id === "MiniMax-H4")
      expect(m4.source).toBe("custom")
      expect(m4.tasks).toEqual(["text2video"])
      expect(m4.note).toBe("next gen")
      // H3 keeps {textOnly: false, ...} → image2video/frames2video, no text2video
      const h3 = parsed.data.models.find((m: { id: string }) => m.id === "MiniMax-H3")
      expect(h3.tasks).toEqual(["image2video", "frames2video"])

      // unknown provider key in models config → hard error
      writeFileSync(
        path.join(configDir, "config.json"),
        JSON.stringify({ models: { volcengine: [{ id: "x" }] } }),
      )
      const bad = await run(["models"], undefined, env)
      expect(bad.code).toBe(3)
      expectErr(bad, "E_CONFIG", "unknown provider 'volcengine'")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("lists models without credentials (discovery is never gated on secrets)", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "cli-models-nokey-"))
    const configDir = path.join(tmp, "cfg")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(path.join(configDir, "config.json"), "{}")
    const env = {
      CREATIFACT_CONFIG_DIR: configDir,
      MINIMAX_API_KEY: "",
      ARK_API_KEY: "",
      ZHIPU_API_KEY: "",
      KLING_API_KEY: "",
      KLING_ACCESS_KEY: "",
      KLING_SECRET_KEY: "",
    }
    try {
      const r = await run(["models", "minimax"], undefined, env)
      expect(r.code).toBe(0)
      const parsed = JSON.parse(r.stdout)
      const m3 = parsed.data.models.find((m: { id: string }) => m.id === "MiniMax-M3")
      expect(m3.tasks).toEqual(["text2text"])
      expect(parsed.data.defaults["text.generate"]).toBe("MiniMax-M2.7")
      expect(parsed.data.models.some((m: { id: string }) => m.id === "MiniMax-H3")).toBe(true)

      const overview = await run(["models"], undefined, env)
      expect(overview.code).toBe(0)
      const all = JSON.parse(overview.stdout)
      const minimax = all.data.providers.find((p: { provider: string }) => p.provider === "minimax")
      expect(minimax.models.some((m: { id: string }) => m.id === "MiniMax-M3")).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("piped stdout stays plain; forced color only affects --pretty", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "cli-color-"))
    const configDir = path.join(tmp, "cfg")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(path.join(configDir, "config.json"), "{}")
    const env = { CREATIFACT_CONFIG_DIR: configDir }
    try {
      // Contract: the default envelope carries zero ANSI escapes — even under
      // CI=true, which picocolors' default heuristics would otherwise color.
      const piped = await run(["models", "kling"], undefined, { ...env, CI: "true" })
      expect(piped.code).toBe(0)
      expect(piped.stdout).not.toContain("\u001b")

      // Forced color + --pretty: stripping must reproduce the plain pretty
      // output byte-for-byte, so the color path can never diverge in content.
      // NO_COLOR="" re-enables color despite the run() pin (spec: only a
      // non-empty NO_COLOR disables).
      const plainPretty = await run(["models", "kling", "--pretty"], undefined, env)
      expect(plainPretty.code).toBe(0)
      expect(plainPretty.stdout).not.toContain("\u001b")
      const colored = await run(["models", "kling", "--pretty"], undefined, {
        ...env,
        FORCE_COLOR: "1",
        NO_COLOR: "",
      })
      expect(colored.code).toBe(0)
      expect(colored.stdout).toContain("\u001b[") // color path really exercised
      expect(stripAnsi(colored.stdout)).toBe(plainPretty.stdout)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("models payload includes derived tasks per model", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "cli-models-json-"))
    const configDir = path.join(tmp, "cfg")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(path.join(configDir, "config.json"), "{}")
    const env = { CREATIFACT_CONFIG_DIR: configDir, MINIMAX_API_KEY: "" }
    try {
      const r = await run(["models", "minimax"], undefined, env)
      expect(r.code).toBe(0)
      const parsed = JSON.parse(r.stdout)
      expect(parsed.kind).toBe("models")
      expect(parsed.data.provider).toBe("minimax")
      expect(parsed.data.defaults["text.generate"]).toBe("MiniMax-M2.7")
      const m3 = parsed.data.models.find((m: { id: string }) => m.id === "MiniMax-M3")
      expect(m3.tasks).toEqual(["text2text"])
      const h3 = parsed.data.models.find((m: { id: string }) => m.id === "MiniMax-H3")
      expect(h3.tasks).toEqual(["image2video", "frames2video"])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe("cli package store — integration", () => {
  it("package ls lists tags; package rm untags and GCs blobs", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "oci-cli-rm-"))
    const configDir = path.join(tmp, "cfg")
    const fixture = path.join(tmp, "assets")
    mkdirSync(configDir, { recursive: true })
    mkdirSync(fixture, { recursive: true })
    writeFileSync(path.join(fixture, "a.txt"), "hello")
    const env = { CREATIFACT_CONFIG_DIR: configDir }
    try {
      await run(["build", "--dir", fixture, "-t", "demo/a:1"], undefined, env)
      await run(["build", "--dir", fixture, "-t", "demo/b:1"], undefined, env)

      const viaPkg = await run(["package", "list"], undefined, env)
      expect(viaPkg.code).toBe(0)
      expect(JSON.parse(viaPkg.stdout).kind).toBe("package.list")
      expect(viaPkg.stdout).toContain('"ref":"demo/a:1"')

      // rm one tag: shared blobs survive
      const r1 = await run(["package", "rm", "demo/a:1"], undefined, env)
      expect(r1.code).toBe(0)
      expect(JSON.parse(r1.stdout)).toEqual({
        ok: true,
        kind: "package.rm",
        data: { untagged: ["demo/a:1"], deletedBlobs: expect.any(Array) },
      })
      const after = await run(["package", "list"], undefined, env)
      expect(after.stdout).toContain('"ref":"demo/b:1"')
      expect(after.stdout).not.toContain('"ref":"demo/a:1"')

      // rm the last tag: blobs collected
      const r2 = await run(["package", "rm", "demo/b:1"], undefined, env)
      expect(JSON.parse(r2.stdout).data.deletedBlobs.length).toBeGreaterThan(0)
      const empty = await run(["package", "list"], undefined, env)
      expect(JSON.parse(empty.stdout).data.entries).toEqual([])

      // rm of a missing tag fails cleanly
      const r3 = await run(["package", "rm", "nope:1"], undefined, env)
      expect(r3.code).toBe(2)
      expectErr(r3, "E_USAGE", "not found in store")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("package ls lists store tags after builds; rebuild replaces the same tag", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "oci-cli-store-"))
    const configDir = path.join(tmp, "cfg")
    const fixture = path.join(tmp, "assets")
    mkdirSync(configDir, { recursive: true })
    mkdirSync(fixture, { recursive: true })
    writeFileSync(path.join(fixture, "a.txt"), "hello")
    const env = { CREATIFACT_CONFIG_DIR: configDir }
    try {
      const r1 = await run(["build", "--dir", fixture, "-t", "demo/one:1"], undefined, env)
      expect(r1.code).toBe(0)
      expect(r1.stdout).toContain("store")

      const r2 = await run(["build", "--dir", fixture, "-t", "demo/two:1"], undefined, env)
      expect(r2.code).toBe(0)

      const ls = await run(["package", "list"], undefined, env)
      expect(ls.code).toBe(0)
      expect(ls.stdout).toContain("demo/one:1")
      expect(ls.stdout).toContain("demo/two:1")

      // re-tag demo/one:1 → still one entry per tag, index keeps both tags
      const r3 = await run(["build", "--dir", fixture, "-t", "demo/one:1"], undefined, env)
      expect(r3.code).toBe(0)
      const index = JSON.parse(readFileSync(path.join(configDir, "store", "index.json"), "utf8"))
      expect(index.manifests).toHaveLength(2)

      // push of an unknown store tag fails with a helpful message
      const push = await run(["push", "nope/missing:1"], undefined, env)
      expect(push.code).toBe(2)
      expectErr(push, "E_USAGE", "not found in")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("package serve serves the store web UI until interrupted", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "oci-cli-browser-"))
    const configDir = path.join(tmp, "cfg")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ version: 1 }))
    try {
      const help = await run(["package", "serve", "--help"])
      expect(help.code).toBe(0)
      expect(help.stdout).toContain("--browser")
      expect(help.stdout).toContain("--port")

      // the serve flags live on the subcommand, not on package or ls
      const pkgHelp = await run(["package", "--help"])
      expect(pkgHelp.code).toBe(0)
      expect(pkgHelp.stdout).not.toContain("--browser")
      const lsHelp = await run(["package", "ls", "--help"])
      expect(lsHelp.code).toBe(0)
      expect(lsHelp.stdout).not.toContain("--browser")

      // Long-running: the envelope (kind package.serve, carrying the URL)
      // lands on stdout at startup; the process keeps serving until SIGTERM.
      const proc = execa(process.execPath, [CLI, "package", "serve"], {
        reject: false,
        env: { ...process.env, NO_COLOR: "1", CREATIFACT_CONFIG_DIR: configDir },
      })
      const envelope = await new Promise<{ kind: string; url: string }>((resolve, reject) => {
        let buf = ""
        const timer = setTimeout(
          () => reject(new Error("no envelope on stdout within 15s")),
          15_000,
        )
        proc.stdout.on("data", (chunk: Buffer) => {
          buf += chunk.toString("utf8")
          const line = buf.trim().split("\n").at(-1) ?? ""
          if (line === "") return
          try {
            const parsed = JSON.parse(line) as {
              ok: boolean
              kind?: string
              data?: { url?: string }
            }
            if (parsed.ok === true && parsed.kind === "package.serve" && parsed.data?.url) {
              clearTimeout(timer)
              resolve({ kind: parsed.kind, url: parsed.data.url })
            }
          } catch {
            // partial line — wait for more stdout
          }
        })
      })
      expect(envelope.kind).toBe("package.serve")
      expect(envelope.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

      const res = await fetch(`${envelope.url}/api/packages`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual([])

      const shell = await fetch(envelope.url)
      expect(shell.status).toBe(200)
      expect(await shell.text()).toContain('id="app"')

      proc.kill("SIGTERM")
      const done = await proc
      expect(done.exitCode).toBe(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }, 30_000)
})

describe("cli config/auth — integration", () => {
  function configEnv(): { dir: string; env: Record<string, string>; file: string } {
    const dir = mkdtempSync(path.join(tmpdir(), "creatifact-home-"))
    return { dir, env: { CREATIFACT_CONFIG_DIR: dir }, file: path.join(dir, "config.json") }
  }

  it("config path prints the config file location", async () => {
    const { dir, env, file } = configEnv()
    try {
      const { stdout, code } = await run(["config", "path"], undefined, env)
      expect(code).toBe(0)
      expect(JSON.parse(stdout)).toEqual({
        ok: true,
        kind: "config",
        data: { action: "path", path: file },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("auth login --password-stdin writes docker-compatible auths, get/list/logout work", async () => {
    const { dir, env, file } = configEnv()
    try {
      const login = await run(
        ["auth", "login", "localhost:5000", "-u", "testuser", "--password-stdin"],
        "testpass\n",
        env,
      )
      expect(login.code).toBe(0)
      expect(JSON.parse(login.stdout)).toEqual({
        ok: true,
        kind: "login",
        data: { registry: "localhost:5000", username: "testuser" },
      })

      const config = JSON.parse(readFileSync(file, "utf8")) as {
        auths: Record<string, { auth: string; username: string }>
      }
      const expected = Buffer.from("testuser:testpass").toString("base64")
      expect(config.auths["localhost:5000"]).toEqual({ auth: expected, username: "testuser" })

      const get = await run(["config", "get", "auths.localhost:5000.username"], undefined, env)
      expect(get.code).toBe(0)
      expect(JSON.parse(get.stdout)).toEqual({
        ok: true,
        kind: "config",
        data: { action: "get", key: "auths.localhost:5000.username", value: "testuser" },
      })

      const getSecret = await run(["config", "get", "auths.localhost:5000.auth"], undefined, env)
      expect(getSecret.code).toBe(0)
      expect(JSON.parse(getSecret.stdout)).toEqual({
        ok: true,
        kind: "config",
        data: { action: "get", key: "auths.localhost:5000.auth", value: "***", secret: true },
      })

      const list = await run(["config", "list"], undefined, env)
      expect(list.code).toBe(0)
      expect(list.stdout).toContain("***")
      expect(list.stdout).not.toContain("testpass")

      const logout = await run(["auth", "logout", "localhost:5000"], undefined, env)
      expect(logout.code).toBe(0)

      const gone = await run(["config", "get", "auths.localhost:5000.username"], undefined, env)
      expect(gone.code).toBe(2)
      expectErr(gone, "E_USAGE", "config key not found")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)

  it("auth login normalizes registry and logout errors when not logged in", async () => {
    const { dir, env } = configEnv()
    try {
      const login = await run(
        ["auth", "login", "https://REG.example.com/", "-u", "u", "-p", "p"],
        undefined,
        env,
      )
      expect(login.code).toBe(0)
      expect(JSON.parse(login.stdout)).toEqual({
        ok: true,
        kind: "login",
        data: { registry: "reg.example.com", username: "u" },
      })

      const again = await run(["auth", "logout", "reg.example.com"], undefined, env)
      expect(again.code).toBe(0)

      const notLoggedIn = await run(["auth", "logout", "reg.example.com"], undefined, env)
      expect(notLoggedIn.code).toBe(4)
      expectErr(notLoggedIn, "E_AUTH", "Not logged in")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("auth login without registry or username fails", async () => {
    const { dir, env } = configEnv()
    try {
      const noRegistry = await run(["auth", "login"], undefined, env)
      expect(noRegistry.code).toBe(2)
      expectErr(noRegistry, "E_USAGE", "requires a <registry>")

      const noUser = await run(["auth", "login", "reg.io", "--password-stdin"], "pw\n", env)
      expect(noUser.code).toBe(2)
      expectErr(noUser, "E_USAGE", "--username")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("config set/get/reset roundtrip and reserved key rejection", async () => {
    const { dir, env, file } = configEnv()
    try {
      const set = await run(
        ["config", "set", "providers.ark.baseUrl", "https://ark.example.com"],
        undefined,
        env,
      )
      expect(set.code).toBe(0)

      const get = await run(["config", "get", "providers.ark.baseUrl"], undefined, env)
      expect(get.code).toBe(0)
      expect(JSON.parse(get.stdout)).toEqual({
        ok: true,
        kind: "config",
        data: { action: "get", key: "providers.ark.baseUrl", value: "https://ark.example.com" },
      })

      const reserved = await run(["config", "set", "version", "2"], undefined, env)
      expect(reserved.code).toBe(3)
      expectErr(reserved, "E_CONFIG", "reserved")

      const reset = await run(["config", "reset"], undefined, env)
      expect(reset.code).toBe(0)
      expect(existsSync(file)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("corrupt config file fails loudly and config reset recovers", async () => {
    const { dir, env, file } = configEnv()
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(file, "{ broken json")

      const pull = await run(["pull", "reg.io/x:1.0"], undefined, env)
      expect(pull.code).toBe(3)
      expectErr(pull, "E_CONFIG", "corrupt")

      const reset = await run(["config", "reset"], undefined, env)
      expect(reset.code).toBe(0)
      expect((await run(["config", "path"], undefined, env)).code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("config --help prints usage", async () => {
    const { stdout, code } = await run(["config", "--help"])
    expect(code).toBe(0)
    expect(stdout).toContain("Usage: creatifact config")
    expect(stdout).toContain("reset")
  })

  it("auth login --help prints usage", async () => {
    const { stdout, code } = await run(["auth", "login", "--help"])
    expect(code).toBe(0)
    expect(stdout).toContain("Usage: creatifact auth login")
  })
})

const DEMO_PLUGIN = `
import { appendFileSync, readFileSync } from "node:fs"
export default (settings, env) => ({
  id: "demo",
  models: [
    { id: "demo-image", capabilities: { "image.generate": { imageInput: true } }, lastVerified: "2026-08" },
    { id: "demo-image-t2i", capabilities: { "image.generate": {} }, lastVerified: "2026-08" },
    { id: "demo-video", capabilities: { "video.generate": { textOnly: true, firstFrame: true, lastFrame: true } }, lastVerified: "2026-08" },
    { id: "demo-stuck", capabilities: { "video.generate": { textOnly: true } }, lastVerified: "2026-08" },
    { id: "demo-vision", capabilities: { "image.understand": {}, "video.understand": {} }, lastVerified: "2026-08" },
    { id: "demo-embed", capabilities: { embed: {} }, lastVerified: "2026-08" },
    { id: "demo-text", capabilities: { "text.generate": {} }, lastVerified: "2026-08" },
  ],
  defaultModels: {
    "text.generate": "demo-text",
    "image.generate": "demo-image-t2i",
    "video.generate": "demo-video",
    "image.understand": "demo-vision",
    "video.understand": "demo-vision",
    embed: "demo-embed",
  },
  textGenerate: {
    async create(req) {
      appendFileSync(settings.recordPath, JSON.stringify(req) + "\\n")
      return { text: "demo text reply" }
    },
  },
  videoGenerate: {
    async submit(req) {
      appendFileSync(settings.recordPath, JSON.stringify(req) + "\\n")
      return { providerId: "demo", id: req.model === "demo-stuck" ? "stuck-task" : "ok-task" }
    },
    async poll(handle) {
      return handle.id === "stuck-task"
        ? { state: "pending" }
        : { state: "done", artifacts: [{ url: "https://cdn.test/out.mp4", mimeType: "video/mp4" }] }
    },
  },
  imageGenerate: {
    async create(req) {
      appendFileSync(settings.recordPath, JSON.stringify(req) + "\\n")
      return { artifacts: [{ url: "https://cdn.test/out.png", mimeType: "image/png" }] }
    },
  },
  imageUnderstand: {
    async create(req) {
      appendFileSync(settings.recordPath, JSON.stringify(req) + "\\n")
      return { text: "it is a demo crane" }
    },
  },
  videoUnderstand: {
    async create(req) {
      appendFileSync(settings.recordPath, JSON.stringify(req) + "\\n")
      return { text: "it is a demo video" }
    },
  },
  embed: {
    async create(req) {
      return { vectors: req.inputs.map(() => [0.1, 0.2]), dimensions: 2 }
    },
  },
})
`

function demoEnv(): {
  env: Record<string, string>
  dir: string
  recordPath: string
  configPath: string
} {
  const dir = mkdtempSync(path.join(tmpdir(), "creatifact-demo-"))
  const pluginPath = path.join(dir, "demo.mjs")
  const recordPath = path.join(dir, "requests.log")
  writeFileSync(pluginPath, DEMO_PLUGIN)
  const configDir = path.join(dir, "cfg")
  mkdirSync(configDir)
  const configPath = path.join(configDir, "config.json")
  writeFileSync(
    configPath,
    JSON.stringify({ providers: { demo: { module: pluginPath, recordPath } } }),
  )
  return { env: { CREATIFACT_CONFIG_DIR: configDir }, dir, recordPath, configPath }
}

function lastRequest(recordPath: string): Record<string, unknown> {
  const lines = readFileSync(recordPath, "utf8").trim().split("\n")
  return JSON.parse(lines[lines.length - 1] ?? "{}")
}

/** Parsed `.creatifact/config.json` metadata (run + result) of a result layout. */
async function readPackageMetadata(resultDir: string): Promise<{
  run: {
    task: string
    images?: string[]
    inputRefs?: Array<{ digest?: string }>
    [key: string]: unknown
  }
  result: {
    createdAt?: string
    from?: string
    text?: string
    artifacts?: Array<Record<string, unknown>>
    [key: string]: unknown
  }
}> {
  const index = JSON.parse(readFileSync(path.join(resultDir, "index.json"), "utf8"))
  const manifest = JSON.parse(
    readFileSync(
      path.join(resultDir, "blobs", "sha256", index.manifests[0].digest.slice(7)),
      "utf8",
    ),
  )
  const layerBlobs = (manifest.layers as Array<{ digest: string }>).map((l) =>
    readFileSync(path.join(resultDir, "blobs", "sha256", l.digest.slice(7))),
  )
  const { view } = await mergeImageLayers(layerBlobs)
  const entry = view.get(METADATA_FILE)
  if (entry === undefined || entry.type !== "file") throw new Error("package metadata missing")
  return JSON.parse(entry.data.toString("utf8"))
}

describe("cli run — integration", () => {
  it("text2text runs chat completion with system prompt", async () => {
    const { env, dir, recordPath } = demoEnv()
    try {
      const r = await run(
        ["run", "text2text", "demo/demo-text", "hello", "--system", "be brief"],
        undefined,
        env,
      )
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("demo text reply")
      expect(lastRequest(recordPath)).toEqual({
        model: "demo-text",
        prompt: "hello",
        system: "be brief",
        options: {},
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("text2image uses the provider's declared default model", async () => {
    const { env, dir, recordPath } = demoEnv()
    try {
      const r = await run(
        ["run", "text2image", "demo", "default crane", "--no-pack"],
        undefined,
        env,
      )
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("https://cdn.test/out.png")
      expect(lastRequest(recordPath)["model"]).toBe("demo-image-t2i")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("image2image requires --image and picks the imageInput model", async () => {
    const { env, dir, recordPath } = demoEnv()
    try {
      const missing = await run(["run", "image2image", "demo", "x"], undefined, env)
      expect(missing.code).toBe(2)
      expectErr(missing, "E_USAGE", "image2image requires --image")

      const img = path.join(dir, "cat.png")
      writeFileSync(img, "png")
      const r = await run(
        ["run", "image2image", "demo", "paint it", "--image", img, "--no-pack"],
        undefined,
        env,
      )
      expect(r.code).toBe(0)
      const req = lastRequest(recordPath)
      expect(req["model"]).toBe("demo-image")
      expect((req["image"] as { localPath: string }).localPath).toBe(img)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("task-inapplicable flags fail at parse time with unknown option", async () => {
    const { env, dir } = demoEnv()
    try {
      const r = await run(
        ["run", "text2video", "demo", "x", "--first-frame", "/nonexistent.png"],
        undefined,
        env,
      )
      expect(r.code).toBe(2)
      // The flag is not registered for text2video (help never shows it), so
      // commander rejects it at parse time before any provider work.
      expectErr(r, "E_USAGE", "unknown option '--first-frame'")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("image2video maps --image to the first frame and packages results", async () => {
    const { env, dir, recordPath } = demoEnv()
    const resultDir = path.join(dir, "result")
    try {
      const img = path.join(dir, "first.png")
      writeFileSync(img, "f")
      const r = await run(
        [
          "run",
          "image2video",
          "demo",
          "animate",
          "--image",
          img,
          "--interval",
          "50ms",
          "--output",
          resultDir,
          "--tag",
          "org/v:1",
        ],
        undefined,
        env,
      )
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("https://cdn.test/out.mp4")
      expect(r.stderr).toContain("built org/v:1")
      const req = lastRequest(recordPath)
      expect(req["model"]).toBe("demo-video")
      expect((req["firstFrame"] as { localPath: string }).localPath).toBe(img)
      expect(req["lastFrame"]).toBeUndefined()

      const config = await readPackageMetadata(resultDir)
      expect(config.run.task).toBe("image2video")
      expect(config.run.images).toEqual([img])
      expect(config.result.from).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("frames2video requires both frames and submits them", async () => {
    const { env, dir, recordPath } = demoEnv()
    try {
      const missing = await run(
        ["run", "frames2video", "demo", "x", "--first-frame", "a.png"],
        undefined,
        env,
      )
      expect(missing.code).toBe(2)
      expectErr(missing, "E_USAGE", "requires --last-frame")

      const a = path.join(dir, "a.png")
      const b = path.join(dir, "b.png")
      writeFileSync(a, "a")
      writeFileSync(b, "b")
      const r = await run(
        [
          "run",
          "frames2video",
          "demo",
          "x",
          "--first-frame",
          a,
          "--last-frame",
          b,
          "--interval",
          "50ms",
          "--no-pack",
        ],
        undefined,
        env,
      )
      expect(r.code).toBe(0)
      const req = lastRequest(recordPath)
      expect((req["firstFrame"] as { localPath: string }).localPath).toBe(a)
      expect((req["lastFrame"] as { localPath: string }).localPath).toBe(b)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("frames2video with an explicit model bypasses the strict filter", async () => {
    const { env, dir } = demoEnv()
    try {
      const a = path.join(dir, "a.png")
      const b = path.join(dir, "b.png")
      writeFileSync(a, "a")
      writeFileSync(b, "b")
      const r = await run(
        [
          "run",
          "frames2video",
          "demo/demo-stuck",
          "x",
          "--first-frame",
          a,
          "--last-frame",
          b,
          "--no-wait",
        ],
        undefined,
        env,
      )
      expect(r.code).toBe(0)
      expect(JSON.parse(r.stdout).data.handle).toEqual({ providerId: "demo", id: "stuck-task" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("image2text and video2text ask questions with attachments", async () => {
    const { env, dir, recordPath } = demoEnv()
    try {
      const img = path.join(dir, "cat.png")
      writeFileSync(img, "png")
      const ask = await run(
        ["run", "image2text", "demo/demo-vision", "what is this", "--input", img],
        undefined,
        env,
      )
      expect(ask.code).toBe(0)
      expect(ask.stdout).toContain("it is a demo crane")
      const req = lastRequest(recordPath)
      expect((req["messages"] as Array<{ content: unknown }>)[0]?.content).toEqual([
        "what is this",
        { file: { localPath: img } },
      ])

      const vid = await run(
        ["run", "video2text", "demo/demo-vision", "--input", "https://cdn.test/v.mp4"],
        undefined,
        env,
      )
      expect(vid.code).toBe(0)
      expect(vid.stdout).toContain("it is a demo video")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("embed returns vectors as JSON", async () => {
    const { env, dir } = demoEnv()
    try {
      const r = await run(["run", "embed", "demo/demo-embed", "a", "b"], undefined, env)
      expect(r.code).toBe(0)
      const parsed = JSON.parse(r.stdout)
      expect(parsed.kind).toBe("run")
      expect(parsed.data.capability).toBe("embed")
      expect(parsed.data.vectors).toEqual([
        [0.1, 0.2],
        [0.1, 0.2],
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("video tasks print a handle with --no-wait and resume polls it", async () => {
    const { env, dir } = demoEnv()
    try {
      const r = await run(
        ["run", "text2video", "demo/demo-video", "x", "--no-wait"],
        undefined,
        env,
      )
      expect(r.code).toBe(0)
      const parsed = JSON.parse(r.stdout)
      expect(parsed.kind).toBe("run")
      expect(parsed.data.handle).toEqual({ providerId: "demo", id: "ok-task" })

      const handleFile = path.join(dir, "job.json")
      writeFileSync(handleFile, JSON.stringify({ providerId: "demo", id: "ok-task" }))
      const resumed = await run(["run", "resume", handleFile, "--interval", "50ms"], undefined, env)
      expect(resumed.code).toBe(0)
      expect(resumed.stdout).toContain("out.mp4")

      const inline = await run(
        ["run", "resume", '{"providerId":"demo","id":"ok-task"}', "--interval", "50ms"],
        undefined,
        env,
      )
      expect(inline.code).toBe(0)
      expect(inline.stdout).toContain("out.mp4")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("video polling timeout surfaces the task handle", async () => {
    const { env, dir } = demoEnv()
    try {
      const r = await run(
        ["run", "text2video", "demo/demo-stuck", "x", "--interval", "50ms", "--timeout", "300ms"],
        undefined,
        env,
      )
      expect(r.code).toBe(8)
      const env1 = expectErr(r, "E_TIMEOUT", "timed out")
      expect(env1.error.details?.["handle"]).toEqual({ providerId: "demo", id: "stuck-task" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("run without a provider uses the configured default provider", async () => {
    const { env, dir, recordPath, configPath } = demoEnv()
    try {
      const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>
      config["defaults"] = { run: { provider: "demo" } }
      writeFileSync(configPath, JSON.stringify(config))

      const r = await run(["run", "text2image", "a crane", "--no-pack"], undefined, env)
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("https://cdn.test/out.png")
      expect(lastRequest(recordPath)["prompt"]).toBe("a crane")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("gen is no longer an alias; aliases were removed in favor of one canonical name", async () => {
    const { env, dir } = demoEnv()
    try {
      const r = await run(["gen"], undefined, env)
      expect(r.code).toBe(2)
      expectErr(r, "E_USAGE", "unknown command: gen")

      const viaLs = await run(["package", "ls"], undefined, env)
      expect(viaLs.code).toBe(2)
      expectErr(viaLs, "E_USAGE", "unknown package action 'ls'")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("unknown tasks and unverified models behave predictably", async () => {
    const { env, dir } = demoEnv()
    try {
      const unknown = await run(["run", "frobnicate"], undefined, env)
      expect(unknown.code).toBe(2)
      expectErr(unknown, "E_USAGE", "unknown task 'frobnicate'")

      const pass = await run(
        ["run", "text2image", "demo/demo-unknown", "x", "--no-pack"],
        undefined,
        env,
      )
      expect(pass.code).toBe(0)
      expect(pass.stdout).toContain("https://cdn.test/out.png")

      const unknownProvider = await run(["run", "text2image", "nope/m", "x"], undefined, env)
      expect(unknownProvider.code).toBe(2)
      expectErr(unknownProvider, "E_USAGE", "unknown provider 'nope'")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("--model <provider>/<model> shorthand resolves the provider too", async () => {
    const { env, dir, recordPath } = demoEnv()
    try {
      const r = await run(
        ["run", "text2image", "a crane", "--model", "demo/demo-image", "--no-pack"],
        undefined,
        env,
      )
      expect(r.code).toBe(0)
      const last = lastRequest(recordPath)
      expect(last["model"]).toBe("demo-image")
      expect(r.stderr).not.toContain("no <provider> given")

      // bare --model without provider still needs a default provider
      const bare = await run(
        ["run", "text2image", "a crane", "--model", "demo-image", "--no-pack"],
        undefined,
        env,
      )
      expect(bare.code).toBe(2)
      expectErr(bare, "E_USAGE", "no <provider> given")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("errors on missing credentials for real providers", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "creatifact-empty-"))
    try {
      const env = { CREATIFACT_CONFIG_DIR: dir }
      const r = await run(["run", "text2image", "zhipu/cogview-4", "x"], undefined, env)
      expect(r.code).toBe(6)
      expectErr(r, "E_PROVIDER", "missing Zhipu API key")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("run --help prints usage and each task has help", async () => {
    const res = await run(["run", "--help"])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain("Usage: creatifact run <task>")
    expect(res.stdout).toContain("image2image")
    expect(res.stdout).toContain("frames2video")

    for (const task of [
      "text2text",
      "image2text",
      "video2text",
      "text2image",
      "image2image",
      "text2video",
      "image2video",
      "frames2video",
      "embed",
      "resume",
    ]) {
      const { stdout, code } = await run(["run", task, "--help"])
      expect(code).toBe(0)
      expect(stdout).toContain(`Usage: creatifact run ${task}`)
    }
  }, 15_000)

  it("build executes the run section: artifacts become the top layer and the config records the run", async () => {
    const { env, dir, recordPath } = demoEnv()
    const outDir = path.join(dir, "built")
    const manifestPath = path.join(dir, "creatifact.json")
    writeFileSync(
      manifestPath,
      JSON.stringify({
        run: { task: "text2image", provider: "demo/demo-image-t2i", prompt: "a cat" },
      }),
    )
    try {
      const r = await run(
        ["build", "-f", manifestPath, "-t", "org/run:1.0", "-o", outDir],
        undefined,
        env,
      )
      expect(r.code, r.stderr).toBe(0)
      expect(r.stderr).toContain("run: running text2image")

      const index = JSON.parse(readFileSync(path.join(outDir, "index.json"), "utf8"))
      const manifest = JSON.parse(
        readFileSync(
          path.join(outDir, "blobs", "sha256", index.manifests[0].digest.slice(7)),
          "utf8",
        ),
      )
      // Demo artifacts are cdn.test urls (unreachable) — the staging
      // degrades to url-only records: no artifact layer, just the metadata
      // layer recording the run.
      expect(manifest.layers).toHaveLength(1)
      const config = await readPackageMetadata(outDir)
      // The executed spec (provider/model resolved) plus a result meta —
      // the digest pins this exact run.
      expect(config.run).toEqual({
        task: "text2image",
        provider: "demo",
        model: "demo-image-t2i",
        prompt: "a cat",
      })
      expect(config.result.createdAt).toBeDefined()
      expect(config.result.artifacts).toEqual([
        { url: "https://cdn.test/out.png", mimeType: "image/png" },
      ])
      // The provider really ran.
      const requests = readFileSync(recordPath, "utf8").trim().split("\n")
      expect(requests.length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("build stages orchestrate a DAG: independent stages run concurrently, references order them", async () => {
    const { env, dir } = demoEnv()
    const assetsDir = path.join(dir, "assets")
    mkdirSync(assetsDir, { recursive: true })
    writeFileSync(path.join(assetsDir, "a.txt"), "x")
    const manifestPath = path.join(dir, "creatifact.json")
    writeFileSync(
      manifestPath,
      JSON.stringify({
        stages: [
          {
            name: "cat",
            run: { task: "text2image", provider: "demo/demo-image-t2i", prompt: "a cat" },
          },
          {
            name: "dog",
            run: { task: "text2image", provider: "demo/demo-image-t2i", prompt: "a dog" },
          },
          {
            name: "combo",
            assets: assetsDir,
            // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture for the ${...} stage-ref syntax
            annotations: { cat: "${cat.digest}", dog: "${dog.digest}" },
          },
        ],
      }),
    )
    try {
      const r = await run(["build", "-f", manifestPath, "-t", "demo/stages:1"], undefined, env)
      expect(r.code, r.stderr).toBe(0)
      const lastLine = r.stdout.trimEnd().split("\n").filter(Boolean).at(-1) ?? ""
      const out = JSON.parse(lastLine) as {
        data: {
          tag: string
          stages: Array<{ name: string; tag: string }>
        }
      }
      // Three stage packages in the store; the final product is the last
      // stage, aliased under the manifest's own tag.
      expect(out.data.stages.map((s) => s.name)).toEqual(["cat", "dog", "combo"])
      expect(out.data.stages[0]?.tag).toBe("demo/stages/cat:1")
      expect(out.data.stages[1]?.tag).toBe("demo/stages/dog:1")
      expect(out.data.stages[2]?.tag).toBe("demo/stages/combo:1")
      expect(out.data.tag).toBe("demo/stages:1")
      // The combo stage's annotations resolved the parallel stages' digests.
      const store = path.join(env["CREATIFACT_CONFIG_DIR"] ?? "", "store")
      const comboIndex = JSON.parse(readFileSync(path.join(store, "index.json"), "utf8"))
      const comboEntry = comboIndex.manifests.find(
        (m: { annotations?: Record<string, string> }) =>
          m.annotations?.["org.opencontainers.image.ref.name"] === "demo/stages/combo:1",
      )
      const comboManifest = JSON.parse(
        readFileSync(path.join(store, "blobs", "sha256", comboEntry.digest.slice(7)), "utf8"),
      )
      expect(comboManifest.annotations.cat).toMatch(/^sha256:/)
      expect(comboManifest.annotations.dog).toMatch(/^sha256:/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("build rejects stages mixed with top-level sections", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "creatifact-stages-err-"))
    const manifestPath = path.join(dir, "creatifact.json")
    writeFileSync(
      manifestPath,
      JSON.stringify({
        run: { task: "text2image", prompt: "x" },
        stages: [{ name: "a", run: { task: "text2image", prompt: "x" } }],
      }),
    )
    try {
      const r = await run(["build", "-f", manifestPath, "-t", "x/y:1"])
      expect(r.code).toBe(1)
      expect(r.stderr).toContain("cannot combine 'stages'")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("build stages copy combines parallel run outputs into one image (content composition)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "creatifact-stages-copy-"))
    const pluginPath = path.join(dir, "bytes.mjs")
    writeFileSync(
      pluginPath,
      `
export default (settings) => ({
  id: "demo",
  models: [{ id: "img", capabilities: { "image.generate": {} }, lastVerified: "2026-08" }],
  defaultModels: { "image.generate": "img" },
  imageGenerate: {
    async create(req) {
      const tag = req.prompt === "cat" ? "CATIMG" : "DOGIMG"
      return { artifacts: [{ base64: Buffer.from(tag).toString("base64"), mimeType: "image/png" }] }
    },
  },
})
`,
    )
    const configDir = path.join(dir, "cfg")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ providers: { demo: { module: pluginPath } } }),
    )
    const env = { CREATIFACT_CONFIG_DIR: configDir }
    const manifestPath = path.join(dir, "creatifact.json")
    writeFileSync(
      manifestPath,
      JSON.stringify({
        stages: [
          { name: "cat", run: { task: "text2image", provider: "demo", prompt: "cat" } },
          { name: "dog", run: { task: "text2image", provider: "demo", prompt: "dog" } },
          {
            name: "combo",
            // biome-ignore-start lint/suspicious/noTemplateCurlyInString: fixture for the ${...} stage-ref syntax
            copy: [
              { from: "${cat.tag}", paths: ["artifact-1.png"] },
              { from: "${dog.tag}", paths: ["artifact-1.png"] },
            ],
            annotations: { t: "${cat.digest}", b: "${dog.digest}" },
            // biome-ignore-end lint/suspicious/noTemplateCurlyInString: fixture for the ${...} stage-ref syntax
          },
        ],
      }),
    )
    try {
      const r = await run(["build", "-f", manifestPath, "-t", "org/st:1"], undefined, env)
      expect(r.code, r.stderr).toBe(0)
      const lastLine = r.stdout.trimEnd().split("\n").filter(Boolean).at(-1) ?? ""
      const out = JSON.parse(lastLine) as { data: { stages: Array<{ name: string }> } }
      expect(out.data.stages.map((s) => s.name)).toEqual(["cat", "dog", "combo"])

      // The combo package combines both stages' artifact layers: two layers
      // whose bytes are the two generated artifacts.
      const store = path.join(configDir, "store")
      const index = JSON.parse(readFileSync(path.join(store, "index.json"), "utf8"))
      const comboEntry = index.manifests.find(
        (m: { annotations?: Record<string, string> }) =>
          m.annotations?.["org.opencontainers.image.ref.name"] === "org/st/combo:1",
      )
      const manifest = JSON.parse(
        readFileSync(path.join(store, "blobs", "sha256", comboEntry.digest.slice(7)), "utf8"),
      )
      expect(manifest.layers).toHaveLength(2)
      const blobs = manifest.layers.map((l: { digest: string }) =>
        readFileSync(path.join(store, "blobs", "sha256", l.digest.slice(7))),
      )
      const layerTexts = blobs.map((b: Buffer) => gunzipSync(b).toString("latin1"))
      const catLayer = layerTexts.find((t: string) => t.includes("CATIMG"))
      const dogLayer = layerTexts.find((t: string) => t.includes("DOGIMG"))
      expect(catLayer, "cat artifact layer copied in").toBeDefined()
      expect(dogLayer, "dog artifact layer copied in").toBeDefined()
      expect(manifest.annotations).toMatchObject({
        t: expect.stringMatching(/^sha256:/),
        b: expect.stringMatching(/^sha256:/),
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("build stages reuse unchanged stages across runs (incremental, no re-billing)", async () => {
    const { env, dir, recordPath } = demoEnv()
    const manifestPath = path.join(dir, "creatifact.json")
    writeFileSync(
      manifestPath,
      JSON.stringify({
        stages: [
          { name: "cat", run: { task: "text2image", provider: "demo", prompt: "a cat" } },
          { name: "dog", run: { task: "text2image", provider: "demo", prompt: "a dog" } },
          {
            name: "combo",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture for the ${...} stage-ref syntax
            annotations: { c: "${cat.digest}", d: "${dog.digest}" },
          },
        ],
      }),
    )
    try {
      const build = () => run(["build", "-f", manifestPath, "-t", "demo/stages:1"], undefined, env)
      const first = await build()
      expect(first.code, first.stderr).toBe(0)
      const firstOut = JSON.parse(lastLine(first.stdout)) as {
        data: { plan: { stages: Array<{ status: string }> } }
      }
      expect(firstOut.data.plan.stages.map((s) => s.status)).toEqual([
        "executed",
        "executed",
        "executed",
      ])
      expect(readFileSync(recordPath, "utf8").trim().split("\n").filter(Boolean)).toHaveLength(2)

      const second = await build()
      expect(second.code, second.stderr).toBe(0)
      expect(second.stderr).toContain("reusing")
      const secondOut = JSON.parse(lastLine(second.stdout)) as {
        data: {
          stages: Array<{ name: string; reused?: boolean }>
          plan: { stages: Array<{ status: string }> }
        }
      }
      expect(secondOut.data.stages.map((s) => s.reused)).toEqual([true, true, true])
      expect(secondOut.data.plan.stages.map((s) => s.status)).toEqual([
        "reused",
        "reused",
        "reused",
      ])
      // Zero additional provider calls: nothing was re-billed.
      expect(readFileSync(recordPath, "utf8").trim().split("\n").filter(Boolean)).toHaveLength(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("build --force re-runs every stage", async () => {
    const { env, dir, recordPath } = demoEnv()
    const manifestPath = path.join(dir, "creatifact.json")
    writeFileSync(
      manifestPath,
      JSON.stringify({ run: { task: "text2image", provider: "demo", prompt: "a crane" } }),
    )
    try {
      await run(["build", "-f", manifestPath, "-t", "demo/f:1"], undefined, env)
      const forced = await run(
        ["build", "--force", "-f", manifestPath, "-t", "demo/f:1"],
        undefined,
        env,
      )
      expect(forced.code, forced.stderr).toBe(0)
      const out = JSON.parse(lastLine(forced.stdout)) as {
        data: { plan: { stages: Array<{ status: string }> } }
      }
      expect(out.data.plan.stages[0]?.status).toBe("executed")
      expect(readFileSync(recordPath, "utf8").trim().split("\n").filter(Boolean)).toHaveLength(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("build --plan prints the plan envelope without executing or writing", async () => {
    const { env, dir, recordPath } = demoEnv()
    const manifestPath = path.join(dir, "creatifact.json")
    writeFileSync(
      manifestPath,
      JSON.stringify({ run: { task: "text2image", provider: "demo", prompt: "a crane" } }),
    )
    try {
      const planned = await run(
        ["build", "--plan", "-f", manifestPath, "-t", "demo/plan:1"],
        undefined,
        env,
      )
      expect(planned.code, planned.stderr).toBe(0)
      const out = JSON.parse(lastLine(planned.stdout)) as {
        data: {
          executed: boolean
          plan: { stages: Array<{ status: string; inputsDigest: string }> }
        }
      }
      expect(out.data.executed).toBe(false)
      expect(out.data.plan.stages[0]?.status).toBe("would-execute")
      expect(out.data.plan.stages[0]?.inputsDigest).toMatch(/^sha256:/)
      // No provider calls, no store writes.
      expect(existsSync(recordPath) ? readFileSync(recordPath, "utf8").trim() : "").toBe("")
      const store = path.join(env["CREATIFACT_CONFIG_DIR"] ?? "", "store")
      expect(existsSync(store)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture for the ${...} stage-ref syntax
  it("build stages resolve ${name.artifacts[0].url} references", async () => {
    const { env, dir } = demoEnv()
    const manifestPath = path.join(dir, "creatifact.json")
    writeFileSync(
      manifestPath,
      JSON.stringify({
        stages: [
          { name: "cat", run: { task: "text2image", provider: "demo", prompt: "a cat" } },
          {
            name: "combo",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture for the ${...} stage-ref syntax
            annotations: { u: "${cat.artifacts[0].url}" },
          },
        ],
      }),
    )
    try {
      const r = await run(["build", "-f", manifestPath, "-t", "demo/arts:1"], undefined, env)
      expect(r.code, r.stderr).toBe(0)
      const store = path.join(env["CREATIFACT_CONFIG_DIR"] ?? "", "store")
      const index = JSON.parse(readFileSync(path.join(store, "index.json"), "utf8"))
      const comboEntry = index.manifests.find(
        (m: { annotations?: Record<string, string> }) =>
          m.annotations?.["org.opencontainers.image.ref.name"] === "demo/arts/combo:1",
      )
      const manifest = JSON.parse(
        readFileSync(path.join(store, "blobs", "sha256", comboEntry.digest.slice(7)), "utf8"),
      )
      expect(manifest.annotations.u).toBe("https://cdn.test/out.png")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("build run section + run <ref> runs the recipe and packages results", async () => {
    const { env, dir, recordPath } = demoEnv()
    const recipeDir = path.join(dir, "recipe")
    const resultDir = path.join(dir, "result")
    const manifestPath = path.join(dir, "creatifact.json")
    writeFileSync(
      manifestPath,
      JSON.stringify({
        run: {
          task: "text2image",
          provider: "demo",
          model: "demo-image",
          options: { quality: "hd" },
        },
      }),
    )
    try {
      const built = await run([
        "build",
        "--bake",
        "-f",
        manifestPath,
        "-t",
        "example.com/xxxxxx:v1.0",
        "-o",
        recipeDir,
      ])
      expect(built.code).toBe(0)
      expect(built.stderr).toContain("built example.com/xxxxxx:v1.0")

      const res = await run(
        [
          "run",
          recipeDir,
          "override crane",
          "--opt",
          "size=1024x1024",
          "--output",
          resultDir,
          "--tag",
          "org/result:1.0",
        ],
        undefined,
        env,
      )
      expect(res.code, res.stderr).toBe(0)
      expect(res.stdout).toContain("https://cdn.test/out.png")
      expect(res.stderr).toContain("built org/result:1.0")

      const req = lastRequest(recordPath)
      expect(req["prompt"]).toBe("override crane")
      expect(req["options"]).toEqual({ quality: "hd", size: "1024x1024" })

      const index = JSON.parse(readFileSync(path.join(resultDir, "index.json"), "utf8"))
      expect(index.manifests[0].annotations["org.opencontainers.image.ref.name"]).toBe(
        "org/result:1.0",
      )
      const config = await readPackageMetadata(resultDir)
      expect(config.run).toEqual({
        task: "text2image",
        provider: "demo",
        model: "demo-image",
        prompt: "override crane",
        options: { quality: "hd", size: "1024x1024" },
      })
      expect(config.result.from).toBe(recipeDir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("run <ref> materializes pkg:// reference images from package layers", async () => {
    const { env, dir, recordPath } = demoEnv()
    const assetsDir = path.join(dir, "assets")
    const recipeDir = path.join(dir, "recipe")
    const resultDir = path.join(dir, "result")
    mkdirSync(assetsDir, { recursive: true })
    writeFileSync(path.join(assetsDir, "ref.png"), "REFIMAGE")
    const manifestPath = path.join(dir, "creatifact.json")
    writeFileSync(
      manifestPath,
      JSON.stringify({
        run: {
          task: "image2image",
          provider: "demo",
          model: "demo-image",
          images: ["pkg://ref.png"],
        },
        assets: assetsDir,
      }),
    )
    try {
      const built = await run([
        "build",
        "--bake",
        "-f",
        manifestPath,
        "-t",
        "example.com/img2img:v1.0",
        "-o",
        recipeDir,
      ])
      expect(built.code).toBe(0)

      const res = await run(["run", recipeDir, "paint it", "--output", resultDir], undefined, env)
      expect(res.code, res.stderr).toBe(0)
      expect(res.stdout).toContain("https://cdn.test/out.png")

      const req = lastRequest(recordPath)
      expect((req["image"] as { localPath: string }).localPath).toMatch(/creatifact-pkgref-/)
      expect((req["image"] as { localPath: string }).localPath).toContain("ref.png")

      const config = await readPackageMetadata(resultDir)
      // provenance keeps the original pkg:// reference
      expect(config.run.images).toEqual(["pkg://ref.png"])
      expect(config.run["prompt"]).toBe("paint it")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("run <ref> reads a pkg:// prompt inline from package layers", async () => {
    const { env, dir, recordPath } = demoEnv()
    const assetsDir = path.join(dir, "assets")
    const recipeDir = path.join(dir, "recipe")
    mkdirSync(assetsDir, { recursive: true })
    writeFileSync(path.join(assetsDir, "story.txt"), "a crane over the west lake at dusk")
    const manifestPath = path.join(dir, "creatifact.json")
    writeFileSync(
      manifestPath,
      JSON.stringify({
        run: {
          task: "text2image",
          provider: "demo",
          model: "demo-image",
          prompt: "pkg://story.txt",
        },
        assets: assetsDir,
      }),
    )
    try {
      const built = await run([
        "build",
        "--bake",
        "-f",
        manifestPath,
        "-t",
        "example.com/prompt-pkg:v1.0",
        "-o",
        recipeDir,
      ])
      expect(built.code).toBe(0)

      const res = await run(["run", recipeDir, "--no-pack"], undefined, env)
      expect(res.code, res.stderr).toBe(0)

      // the prompt is the file's text, not the pkg:// ref itself
      const req = lastRequest(recordPath)
      expect(req["prompt"]).toBe("a crane over the west lake at dusk")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("run text2text --tag packs the text as a referenceable OCI package", async () => {
    const { env, dir } = demoEnv()
    const resultDir = path.join(dir, "result")
    try {
      const res = await run(
        [
          "run",
          "text2text",
          "demo/demo-text",
          "hello",
          "--tag",
          "org/story:1",
          "--output",
          resultDir,
        ],
        undefined,
        env,
      )
      expect(res.code, res.stderr).toBe(0)
      const parsed = JSON.parse(res.stdout) as {
        data: { text: string; tag: string; digest: string; outputDir: string }
      }
      expect(parsed.data.text).toBe("demo text reply")
      expect(parsed.data.tag).toBe("org/story:1")
      expect(parsed.data.digest).toMatch(/^sha256:/)

      const index = JSON.parse(readFileSync(path.join(resultDir, "index.json"), "utf8"))
      const manifest = JSON.parse(
        readFileSync(
          path.join(resultDir, "blobs", "sha256", index.manifests[0].digest.slice(7)),
          "utf8",
        ),
      )
      expect(manifest.layers).toHaveLength(1)
      const config = await readPackageMetadata(resultDir)
      expect(config.run.task).toBe("text2text")
      expect(config.result.text).toBe("demo text reply")
      expect(config.result.artifacts).toEqual([{ name: "text.txt", mimeType: "text/plain" }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("--list-models returns supporting models with defaults", async () => {
    const { env, dir } = demoEnv()
    try {
      const r = await run(["run", "image2text", "--list-models"], undefined, env)
      expect(r.code).toBe(0)
      const parsed = JSON.parse(r.stdout)
      expect(parsed.kind).toBe("run")
      expect(parsed.data.task).toBe("image2text")
      const demoEntry = parsed.data.models.entries.find(
        (e: { provider: string }) => e.provider === "demo",
      )
      expect(demoEntry).toEqual({ provider: "demo", model: "demo-vision", default: true })

      // provider scope positional filters to that provider
      const scoped = await run(["run", "text2text", "demo", "--list-models"], undefined, env)
      expect(scoped.code).toBe(0)
      const scopedParsed = JSON.parse(scoped.stdout)
      expect(
        scopedParsed.data.models.entries.some((e: { model: string }) => e.model === "demo-text"),
      ).toBe(true)

      // task with no supporter on the scoped provider: informative stderr, exit 0
      const empty = await run(["run", "video2text", "minimax", "--list-models"], undefined, env)
      expect(empty.code).toBe(0)
      expect(empty.stderr).toContain("no verified model supports video2text on 'minimax'")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("model-selection errors inline cross-provider suggestions", async () => {
    const { env, dir, configPath } = demoEnv()
    // minimax constructs fine (key from config) but has no video.understand model
    writeFileSync(
      configPath,
      JSON.stringify({
        providers: {
          demo: JSON.parse(readFileSync(configPath, "utf8")).providers.demo,
          minimax: { apiKey: "k" },
        },
      }),
    )
    try {
      const r = await run(["run", "video2text", "minimax", "q", "--input", "a.mp4"], undefined, env)
      expect(r.code).toBe(2)
      expectErr(r, "E_USAGE", "has no model for video.understand")
      expect(r.stderr).toContain("models that support video2text:")
      expect(r.stderr).toContain("demo/demo-vision")
      expect(r.stderr).toContain("--list-models")

      // explicit model that exists but supports a different capability → warning + suggestions
      const w = await run(["run", "text2text", "demo/demo-image", "hi"], undefined, env)
      expect(w.stderr).toContain("'demo-image' is not marked as supporting text2text")
      expect(w.stderr).toContain("demo/demo-text")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("models lists providers, plugin details, and errors on unknown", async () => {
    const { env, dir } = demoEnv()
    try {
      const all = await run(["models"], undefined, env)
      expect(all.code).toBe(0)
      // every configured provider appears in the JSON catalog
      const parsedAll = JSON.parse(all.stdout)
      expect(parsedAll.kind).toBe("models")
      const ids = parsedAll.data.providers.map((p: { provider: string }) => p.provider)
      expect(ids).toContain("minimax")
      expect(ids).toContain("demo")
      expect(parsedAll.data.providers.every((p: { error?: string }) => p.error === undefined)).toBe(
        true,
      )

      const one = await run(["models", "demo"], undefined, env)
      expect(one.code).toBe(0)
      const parsedOne = JSON.parse(one.stdout)
      const modelIds = parsedOne.data.models.map((m: { id: string }) => m.id)
      expect(modelIds).toContain("demo-image")
      expect(modelIds).toContain("demo-vision")

      const j = await run(["models", "demo"], undefined, env)
      expect(JSON.parse(j.stdout).data.models).toHaveLength(7)

      expectErr(await run(["models", "nope"], undefined, env), "E_USAGE", "unknown provider")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("--config-dir redirects provider and config lookups", async () => {
    const { env, dir } = demoEnv()
    const configDir = path.join(dir, "cfg")
    try {
      // No CREATIFACT_CONFIG_DIR: the flag alone must route config reads.
      const models = await run(["models", "--config-dir", configDir])
      expect(models.code).toBe(0)
      expect(models.stdout).toContain('"demo-image"')
      // credential-free built-ins list cleanly instead of erroring
      expect(models.stderr).not.toContain("unavailable")

      const configPath = await run(["config", "path", "--config-dir", configDir])
      expect(configPath.code).toBe(0)
      expect(JSON.parse(configPath.stdout)).toEqual({
        ok: true,
        kind: "config",
        data: { action: "path", path: path.join(configDir, "config.json") },
      })

      const res = await run(
        ["run", "text2image", "demo/demo-image", "x", "--no-pack", "--config-dir", configDir],
        undefined,
        env,
      )
      expect(res.code).toBe(0)
      expect(res.stdout).toContain("https://cdn.test/out.png")

      const missing = await run(["models", "--config-dir"])
      expect(missing.code).toBe(2)
      expectErr(missing, "E_USAGE", "--config-dir")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("run --prompt-file conflicts with --prompt (E_USAGE)", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "run-cli-test-"))
    const promptPath = path.join(tmp, "p.md")
    writeFileSync(promptPath, "x")

    try {
      const r = await run(["run", "text2image", "--prompt-file", promptPath, "--prompt", "y"])
      expect(r.code).toBe(2)
      expectErr(r, "E_USAGE", "--prompt-file and --prompt are mutually exclusive")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe("cli -f file-driven — integration", () => {
  it("-f --help prints usage", async () => {
    const { stdout, code } = await run(["-f", "--help"])
    expect(code).toBe(0)
    expect(stdout).toContain("Usage: creatifact -f <file>.json")
  })

  it("runs run.text2image from a JSON file, CLI flags override fields", async () => {
    const { env, dir, recordPath } = demoEnv()
    const reqPath = path.join(dir, "req.json")
    const resultDir = path.join(dir, "result")
    writeFileSync(
      reqPath,
      JSON.stringify({
        command: "run.text2image",
        provider: "demo/demo-image",
        prompt: "file crane",
        options: { quality: "hd" },
      }),
    )
    try {
      // File-only run
      const r = await run(["-f", reqPath, "--output", resultDir], undefined, env)
      expect(r.code).toBe(0)
      const parsed = JSON.parse(r.stdout) as {
        kind: string
        data: { capability: string; artifacts: { url: string }[] }
      }
      expect(parsed.kind).toBe("run")
      expect(parsed.data.capability).toBe("image.generate")
      expect(parsed.data.artifacts[0]?.url).toContain("out.png")

      const req = lastRequest(recordPath)
      expect(req["prompt"]).toBe("file crane")
      expect(req["options"]).toEqual({ quality: "hd" })

      // CLI positional prompt + --opt override the file's fields
      const overridden = await run(
        [
          "-f",
          reqPath,
          "cli crane",
          "--opt",
          "quality=standard",
          "--output",
          path.join(dir, "result2"),
        ],
        undefined,
        env,
      )
      expect(overridden.code).toBe(0)
      const req2 = lastRequest(recordPath)
      expect(req2["prompt"]).toBe("cli crane")
      expect(req2["options"]).toEqual({ quality: "standard" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("runs run.text2video --no-wait and run.embed from JSON files", async () => {
    const { env, dir } = demoEnv()
    try {
      const videoPath = path.join(dir, "video.json")
      writeFileSync(
        videoPath,
        JSON.stringify({
          command: "run.text2video",
          provider: "demo",
          prompt: "x",
          noWait: true,
        }),
      )
      const v = await run(["-f", videoPath], undefined, env)
      expect(v.code).toBe(0)
      expect(JSON.parse(v.stdout).data.handle).toEqual({ providerId: "demo", id: "ok-task" })

      const textPath = path.join(dir, "text.json")
      writeFileSync(
        textPath,
        JSON.stringify({ command: "run.text2text", provider: "demo", prompt: "hi" }),
      )
      const t = await run(["-f", textPath], undefined, env)
      expect(t.code).toBe(0)
      expect(t.stdout).toContain("demo text reply")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("runs build from a JSON file", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "oci-file-test-"))
    const fixtureDir = path.join(tmp, "fixture")
    const outputDir = path.join(tmp, "output")
    mkdirSync(fixtureDir, { recursive: true })
    writeFileSync(path.join(fixtureDir, "asset.txt"), "from file")
    const reqPath = path.join(tmp, "req.json")
    writeFileSync(
      reqPath,
      JSON.stringify({
        command: "build",
        tag: "file/test:1.0",
        dir: fixtureDir,
        output: outputDir,
        annotations: { "org.creatifact.from": "file" },
      }),
    )
    try {
      const { stdout, stderr, code } = await run(["-f", reqPath])
      expect(code).toBe(0)
      expect(stdout).toContain("file/test:1.0")
      expect(stderr).toContain("built file/test:1.0")
      const index = JSON.parse(readFileSync(path.join(outputDir, "index.json"), "utf8"))
      const manifest = JSON.parse(
        readFileSync(
          path.join(outputDir, "blobs", "sha256", index.manifests[0].digest.slice(7)),
          "utf8",
        ),
      )
      expect(manifest.annotations["org.creatifact.from"]).toBe("file")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("runs auth.login and config.set from JSON files", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "creatifact-file-auth-"))
    const env = { CREATIFACT_CONFIG_DIR: dir }
    try {
      const loginPath = path.join(dir, "login.json")
      writeFileSync(
        loginPath,
        JSON.stringify({
          command: "auth.login",
          registry: "localhost:5000",
          username: "fileuser",
          password: "filepass",
        }),
      )
      const login = await run(["-f", loginPath], undefined, env)
      expect(login.code).toBe(0)
      expect(JSON.parse(login.stdout)).toEqual({
        ok: true,
        kind: "login",
        data: { registry: "localhost:5000", username: "fileuser" },
      })

      const setPath = path.join(dir, "set.json")
      writeFileSync(
        setPath,
        JSON.stringify({ command: "config.set", key: "defaults.run.provider", value: "demo" }),
      )
      const set = await run(["-f", setPath], undefined, env)
      expect(set.code).toBe(0)
      expect(set.stdout).toContain('"key":"defaults.run.provider"')

      const get = await run(["config", "get", "defaults.run.provider"], undefined, env)
      expect(JSON.parse(get.stdout)).toEqual({
        ok: true,
        kind: "config",
        data: { action: "get", key: "defaults.run.provider", value: "demo" },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects bad JSON, unknown commands, and unknown fields", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "creatifact-file-err-"))
    try {
      const badJson = path.join(dir, "bad.json")
      writeFileSync(badJson, "{ oops")
      const r1 = await run(["-f", badJson])
      expect(r1.code).toBe(2)
      expectErr(r1, "E_USAGE", "not valid JSON")

      const unknown = path.join(dir, "unknown.json")
      writeFileSync(unknown, JSON.stringify({ command: "frobnicate" }))
      const r2 = await run(["-f", unknown])
      expect(r2.code).toBe(2)
      expectErr(r2, "E_USAGE", "unknown command 'frobnicate'")

      const typo = path.join(dir, "typo.json")
      writeFileSync(
        typo,
        JSON.stringify({ command: "run.text2image", provider: "demo", promp: "x" }),
      )
      const r3 = await run(["-f", typo])
      expect(r3.code).toBe(2)
      expectErr(r3, "E_USAGE", "unknown field 'promp'")

      const missing = await run(["-f", path.join(dir, "nope.json")])
      expect(missing.code).toBe(2)
      expectErr(missing, "E_USAGE", "cannot read request file")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rerun falls back to stored bytes when the provider rejects an input url", async () => {
    // data: artifact url → the source package layer holds real bytes without
    // any network (no in-process server needed)
    const servedUrl = `data:image/png;base64,${Buffer.from("SRCIMAGE").toString("base64")}`
    const providersUrl = pathToFileURL(path.resolve("dist/providers/index.mjs")).href

    const dir = mkdtempSync(path.join(tmpdir(), "creatifact-fallback-"))
    const recordPath = path.join(dir, "requests.log")
    const pluginPath = path.join(dir, "demo.mjs")
    writeFileSync(
      pluginPath,
      `
import { appendFileSync } from "node:fs"
import { ProviderError } from ${JSON.stringify(providersUrl)}
export default (settings) => ({
  id: "demo",
  models: [
    { id: "ok-image", capabilities: { "image.generate": {} }, lastVerified: "2026-08" },
    { id: "reject-url-image", capabilities: { "image.generate": { imageInput: true } }, lastVerified: "2026-08" },
  ],
  imageGenerate: {
    async create(req) {
      appendFileSync(settings.recordPath, JSON.stringify(req) + "\\n")
      if (req.model === "reject-url-image" && req.image && "url" in req.image) {
        throw new ProviderError("internal", "input url rejected (simulated expiry)")
      }
      if (req.model === "ok-image") {
        return { artifacts: [{ url: settings.servedUrl, mimeType: "image/png" }] }
      }
      return { artifacts: [{ base64: Buffer.from("EDITED").toString("base64"), mimeType: "image/png" }] }
    },
  },
})
`,
    )
    const configDir = path.join(dir, "cfg")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        providers: { demo: { module: pluginPath, servedUrl, recordPath } },
      }),
    )
    const env = { CREATIFACT_CONFIG_DIR: configDir }

    try {
      // 1. produce a source package whose layer actually holds the url bytes
      const src = await run(
        ["run", "text2image", "demo/ok-image", "a crane", "--tag", "demo/src:v1"],
        undefined,
        env,
      )
      expect(src.code, src.stderr).toBe(0)
      const srcDigest = (JSON.parse(src.stdout) as { data: { digest: string } }).data.digest
      expect(srcDigest).toMatch(/^sha256:/)

      // 2. bake a recipe whose images url will be rejected, with inputRefs anchors
      const recipeDir = path.join(dir, "recipe")
      const manifestPath = path.join(dir, "creatifact.json")
      writeFileSync(
        manifestPath,
        JSON.stringify({
          run: {
            task: "image2image",
            provider: "demo",
            model: "reject-url-image",
            prompt: "edit this",
            images: [servedUrl],
            inputRefs: [
              { field: "images", index: 0, name: "s1", digest: srcDigest, tag: "demo/src:v1" },
            ],
          },
        }),
      )
      const built = await run([
        "build",
        "--bake",
        "-f",
        manifestPath,
        "-t",
        "demo/recipe:v1",
        "-o",
        recipeDir,
      ])
      expect(built.code, built.stderr).toBe(0)

      // 3. rerun: url attempt fails → one retry with stored bytes
      const resultDir = path.join(dir, "result")
      const res = await run(["run", recipeDir, "repaint", "--output", resultDir], undefined, env)
      expect(res.code, res.stderr).toBe(0)
      expect(res.stderr).toContain("retrying with stored bytes")

      const requests = readFileSync(recordPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(requests).toHaveLength(3) // src run + rejected url + fallback retry
      expect(requests[1]?.["image"]).toEqual({ url: servedUrl })
      const retryImage = requests[2]?.["image"] as { localPath: string } | undefined
      expect(retryImage?.localPath).toMatch(/creatifact-fallback-[\w-]+[/\\]artifact-1\.png$/)

      // provenance keeps the original url + anchors; only execution swapped
      const config = await readPackageMetadata(resultDir)
      expect(config.run.images).toEqual([servedUrl])
      expect(config.run.inputRefs?.[0]?.digest).toBe(srcDigest)

      // 4. negative: no inputRefs → the provider error propagates, no retry
      const bareDir = path.join(dir, "recipe-bare")
      const bareManifest = path.join(dir, "creatifact-build-bare.json")
      writeFileSync(
        bareManifest,
        JSON.stringify({
          run: {
            task: "image2image",
            provider: "demo",
            model: "reject-url-image",
            prompt: "repaint",
            images: [servedUrl],
          },
        }),
      )
      const bareBuilt = await run(
        ["build", "--bake", "-f", bareManifest, "-t", "demo/bare:v1", "-o", bareDir],
        undefined,
        env,
      )
      expect(bareBuilt.code, bareBuilt.stderr).toBe(0)
      const bare = await run(["run", bareDir, "repaint"], undefined, env)
      expect(bare.code).not.toBe(0)
      expect(bare.stdout).toBe("")
      expect(bare.stderr).toContain("input url rejected")
      expect(bare.stderr).not.toContain("retrying with stored bytes")
      const after = readFileSync(recordPath, "utf8").trim().split("\n")
      expect(after).toHaveLength(4) // exactly one new attempt, no retry
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects -f orchestration files and redirects to build stages", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "creatifact-f-orch-"))
    try {
      const pipelined = path.join(dir, "p.json")
      writeFileSync(pipelined, JSON.stringify({ pipeline: [{ command: "models" }] }))
      const r1 = await run(["-f", pipelined])
      expect(r1.code).toBe(2)
      expectErr(r1, "E_USAGE", "single command")

      const paralleled = path.join(dir, "par.json")
      writeFileSync(paralleled, JSON.stringify({ parallel: [{ command: "models" }] }))
      const r2 = await run(["-f", paralleled])
      expect(r2.code).toBe(2)
      expectErr(r2, "E_USAGE", "stages")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
