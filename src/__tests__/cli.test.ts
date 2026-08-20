import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import { execa } from "execa"
import { stripAnsi } from "../format"

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
): Promise<RunResult> {
  const result = await execa(process.execPath, [CLI, ...args], {
    ...(input === undefined ? {} : { input }),
    reject: false,
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
    expect(stdout).toContain("gen")
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
      const { stdout, code } = await run([
        "build",
        "--dir",
        fixtureDir,
        "-t",
        "test/fixture:1.0.0",
        "-o",
        outputDir,
      ])

      expect(code).toBe(0)
      expect(stdout).toContain("Built")
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
    const descPath = path.join(tmp, "creatifact-build.json")
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
    const descPath = path.join(tmp, "creatifact-build.json")
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
    const outputDir = path.join(tmp, "output")

    try {
      const first = await run([
        "build",
        "-t",
        "org/source:1.0.0",
        "--dir",
        sourceDir,
        "-o",
        sourceDir,
      ])
      expect(first.code).toBe(0)

      const descPath = path.join(tmp, "creatifact-build.json")
      writeFileSync(descPath, JSON.stringify({ from: sourceDir }))
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
    const descPath = path.join(tmp, "creatifact-build.json")
    writeFileSync(descPath, JSON.stringify({ tag: "old/test:1.0", dir: "./x" }))

    try {
      const { stderr, code } = await run(["build", "-f", descPath])
      expect(code).toBe(2)
      expectErr({ stdout: "", stderr, code } as RunResult, "E_USAGE", "--tag is required")
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

      const viaPkg = await run(["package", "ls"], undefined, env)
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
      const after = await run(["package", "ls"], undefined, env)
      expect(after.stdout).toContain('"ref":"demo/b:1"')
      expect(after.stdout).not.toContain('"ref":"demo/a:1"')

      // rm the last tag: blobs collected
      const r2 = await run(["package", "rm", "demo/b:1"], undefined, env)
      expect(JSON.parse(r2.stdout).data.deletedBlobs.length).toBeGreaterThan(0)
      const empty = await run(["package", "ls"], undefined, env)
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

      const ls = await run(["package", "ls"], undefined, env)
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

/** Digest hex of a result layout's config blob. */
function manifestConfigDigest(resultDir: string): string {
  const index = JSON.parse(readFileSync(path.join(resultDir, "index.json"), "utf8"))
  const manifest = JSON.parse(
    readFileSync(
      path.join(resultDir, "blobs", "sha256", index.manifests[0].digest.slice(7)),
      "utf8",
    ),
  )
  return manifest.config.digest.slice(7)
}

describe("cli generate — integration", () => {
  it("text2text runs chat completion with system prompt", async () => {
    const { env, dir, recordPath } = demoEnv()
    try {
      const r = await run(
        ["generate", "text2text", "demo/demo-text", "hello", "--system", "be brief"],
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
        ["generate", "text2image", "demo", "default crane", "--no-pack"],
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
      const missing = await run(["generate", "image2image", "demo", "x"], undefined, env)
      expect(missing.code).toBe(2)
      expectErr(missing, "E_USAGE", "image2image requires --image")

      const img = path.join(dir, "cat.png")
      writeFileSync(img, "png")
      const r = await run(
        ["generate", "image2image", "demo", "paint it", "--image", img, "--no-pack"],
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
        ["generate", "text2video", "demo", "x", "--first-frame", "/nonexistent.png"],
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
          "generate",
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

      const config = JSON.parse(
        readFileSync(
          path.join(resultDir, "blobs", "sha256", manifestConfigDigest(resultDir)),
          "utf8",
        ),
      )
      expect(config.gen.task).toBe("image2video")
      expect(config.gen.images).toEqual([img])
      expect(config.result.from).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("frames2video requires both frames and submits them", async () => {
    const { env, dir, recordPath } = demoEnv()
    try {
      const missing = await run(
        ["generate", "frames2video", "demo", "x", "--first-frame", "a.png"],
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
          "generate",
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
          "generate",
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
        ["generate", "image2text", "demo/demo-vision", "what is this", "--input", img],
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
        ["generate", "video2text", "demo/demo-vision", "--input", "https://cdn.test/v.mp4"],
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
      const r = await run(["generate", "embed", "demo/demo-embed", "a", "b"], undefined, env)
      expect(r.code).toBe(0)
      const parsed = JSON.parse(r.stdout)
      expect(parsed.kind).toBe("generate")
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
        ["generate", "text2video", "demo/demo-video", "x", "--no-wait"],
        undefined,
        env,
      )
      expect(r.code).toBe(0)
      const parsed = JSON.parse(r.stdout)
      expect(parsed.kind).toBe("generate")
      expect(parsed.data.handle).toEqual({ providerId: "demo", id: "ok-task" })

      const handleFile = path.join(dir, "job.json")
      writeFileSync(handleFile, JSON.stringify({ providerId: "demo", id: "ok-task" }))
      const resumed = await run(
        ["generate", "resume", handleFile, "--interval", "50ms"],
        undefined,
        env,
      )
      expect(resumed.code).toBe(0)
      expect(resumed.stdout).toContain("out.mp4")

      const inline = await run(
        ["generate", "resume", '{"providerId":"demo","id":"ok-task"}', "--interval", "50ms"],
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
        [
          "generate",
          "text2video",
          "demo/demo-stuck",
          "x",
          "--interval",
          "50ms",
          "--timeout",
          "300ms",
        ],
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

  it("generate without a provider uses the configured default provider", async () => {
    const { env, dir, recordPath, configPath } = demoEnv()
    try {
      const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>
      config["defaults"] = { gen: { provider: "demo" } }
      writeFileSync(configPath, JSON.stringify(config))

      const r = await run(["generate", "text2image", "a crane", "--no-pack"], undefined, env)
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("https://cdn.test/out.png")
      expect(lastRequest(recordPath)["prompt"]).toBe("a crane")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("gen is an alias for generate", async () => {
    const { env, dir } = demoEnv()
    try {
      const r = await run(["gen", "text2image", "demo", "x", "--no-pack"], undefined, env)
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("https://cdn.test/out.png")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("unknown tasks and unverified models behave predictably", async () => {
    const { env, dir } = demoEnv()
    try {
      const unknown = await run(["generate", "frobnicate"], undefined, env)
      expect(unknown.code).toBe(2)
      expectErr(unknown, "E_USAGE", "unknown generate task 'frobnicate'")

      const pass = await run(
        ["generate", "text2image", "demo/demo-unknown", "x", "--no-pack"],
        undefined,
        env,
      )
      expect(pass.code).toBe(0)
      expect(pass.stdout).toContain("https://cdn.test/out.png")

      const unknownProvider = await run(["generate", "text2image", "nope/m", "x"], undefined, env)
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
        ["generate", "text2image", "a crane", "--model", "demo/demo-image", "--no-pack"],
        undefined,
        env,
      )
      expect(r.code).toBe(0)
      const last = lastRequest(recordPath)
      expect(last["model"]).toBe("demo-image")
      expect(r.stderr).not.toContain("no <provider> given")

      // bare --model without provider still needs a default provider
      const bare = await run(
        ["generate", "text2image", "a crane", "--model", "demo-image", "--no-pack"],
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
      const r = await run(["generate", "text2image", "zhipu/cogview-4", "x"], undefined, env)
      expect(r.code).toBe(6)
      expectErr(r, "E_PROVIDER", "missing Zhipu API key")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("generate --help prints usage and each task has help", async () => {
    const gen = await run(["generate", "--help"])
    expect(gen.code).toBe(0)
    expect(gen.stdout).toContain("Usage: creatifact generate|gen <task>")
    expect(gen.stdout).toContain("image2image")
    expect(gen.stdout).toContain("frames2video")

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
      const { stdout, code } = await run(["generate", task, "--help"])
      expect(code).toBe(0)
      expect(stdout).toContain(`Usage: creatifact generate ${task}`)
    }
  }, 15_000)

  it("build with gen + generate <ref> runs the recipe and packages results", async () => {
    const { env, dir, recordPath } = demoEnv()
    const recipeDir = path.join(dir, "recipe")
    const resultDir = path.join(dir, "result")
    const manifestPath = path.join(dir, "creatifact-build.json")
    writeFileSync(
      manifestPath,
      JSON.stringify({
        gen: {
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
        "-f",
        manifestPath,
        "-t",
        "example.com/xxxxxx:v1.0",
        "-o",
        recipeDir,
      ])
      expect(built.code).toBe(0)
      expect(built.stdout).toContain("Built example.com/xxxxxx:v1.0")

      const gen = await run(
        [
          "generate",
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
      expect(gen.code, gen.stderr).toBe(0)
      expect(gen.stdout).toContain("https://cdn.test/out.png")
      expect(gen.stderr).toContain("built org/result:1.0")

      const req = lastRequest(recordPath)
      expect(req["prompt"]).toBe("override crane")
      expect(req["options"]).toEqual({ quality: "hd", size: "1024x1024" })

      const index = JSON.parse(readFileSync(path.join(resultDir, "index.json"), "utf8"))
      expect(index.manifests[0].annotations["org.opencontainers.image.ref.name"]).toBe(
        "org/result:1.0",
      )
      const manifest = JSON.parse(
        readFileSync(
          path.join(resultDir, "blobs", "sha256", index.manifests[0].digest.slice(7)),
          "utf8",
        ),
      )
      const config = JSON.parse(
        readFileSync(
          path.join(resultDir, "blobs", "sha256", manifest.config.digest.slice(7)),
          "utf8",
        ),
      )
      expect(config.gen).toEqual({
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

  it("generate <ref> materializes pkg:// reference images from package layers", async () => {
    const { env, dir, recordPath } = demoEnv()
    const assetsDir = path.join(dir, "assets")
    const recipeDir = path.join(dir, "recipe")
    const resultDir = path.join(dir, "result")
    mkdirSync(assetsDir, { recursive: true })
    writeFileSync(path.join(assetsDir, "ref.png"), "REFIMAGE")
    const manifestPath = path.join(dir, "creatifact-build.json")
    writeFileSync(
      manifestPath,
      JSON.stringify({
        gen: {
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
        "-f",
        manifestPath,
        "-t",
        "example.com/img2img:v1.0",
        "-o",
        recipeDir,
      ])
      expect(built.code).toBe(0)

      const gen = await run(
        ["generate", recipeDir, "paint it", "--output", resultDir],
        undefined,
        env,
      )
      expect(gen.code, gen.stderr).toBe(0)
      expect(gen.stdout).toContain("https://cdn.test/out.png")

      const req = lastRequest(recordPath)
      expect((req["image"] as { localPath: string }).localPath).toMatch(/creatifact-pkgref-/)
      expect((req["image"] as { localPath: string }).localPath).toContain("ref.png")

      const index = JSON.parse(readFileSync(path.join(resultDir, "index.json"), "utf8"))
      const manifest = JSON.parse(
        readFileSync(
          path.join(resultDir, "blobs", "sha256", index.manifests[0].digest.slice(7)),
          "utf8",
        ),
      )
      const config = JSON.parse(
        readFileSync(
          path.join(resultDir, "blobs", "sha256", manifest.config.digest.slice(7)),
          "utf8",
        ),
      )
      // provenance keeps the original pkg:// reference
      expect(config.gen.images).toEqual(["pkg://ref.png"])
      expect(config.gen["prompt"]).toBe("paint it")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("generate <ref> reads a pkg:// prompt inline from package layers", async () => {
    const { env, dir, recordPath } = demoEnv()
    const assetsDir = path.join(dir, "assets")
    const recipeDir = path.join(dir, "recipe")
    mkdirSync(assetsDir, { recursive: true })
    writeFileSync(path.join(assetsDir, "story.txt"), "a crane over the west lake at dusk")
    const manifestPath = path.join(dir, "creatifact-build.json")
    writeFileSync(
      manifestPath,
      JSON.stringify({
        gen: {
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
        "-f",
        manifestPath,
        "-t",
        "example.com/prompt-pkg:v1.0",
        "-o",
        recipeDir,
      ])
      expect(built.code).toBe(0)

      const gen = await run(["generate", recipeDir, "--no-pack"], undefined, env)
      expect(gen.code, gen.stderr).toBe(0)

      // the prompt is the file's text, not the pkg:// ref itself
      const req = lastRequest(recordPath)
      expect(req["prompt"]).toBe("a crane over the west lake at dusk")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("generate text2text --tag packs the text as a referenceable OCI package", async () => {
    const { env, dir } = demoEnv()
    const resultDir = path.join(dir, "result")
    try {
      const gen = await run(
        [
          "generate",
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
      expect(gen.code, gen.stderr).toBe(0)
      const parsed = JSON.parse(gen.stdout) as {
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
      const config = JSON.parse(
        readFileSync(
          path.join(resultDir, "blobs", "sha256", manifest.config.digest.slice(7)),
          "utf8",
        ),
      )
      expect(config.gen.task).toBe("text2text")
      expect(config.result.text).toBe("demo text reply")
      expect(config.result.artifacts).toEqual([{ name: "text.txt", mimeType: "text/plain" }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("--list-models returns supporting models with defaults", async () => {
    const { env, dir } = demoEnv()
    try {
      const r = await run(["generate", "image2text", "--list-models"], undefined, env)
      expect(r.code).toBe(0)
      const parsed = JSON.parse(r.stdout)
      expect(parsed.kind).toBe("generate")
      expect(parsed.data.task).toBe("image2text")
      const demoEntry = parsed.data.models.entries.find(
        (e: { provider: string }) => e.provider === "demo",
      )
      expect(demoEntry).toEqual({ provider: "demo", model: "demo-vision", default: true })

      // provider scope positional filters to that provider
      const scoped = await run(["generate", "text2text", "demo", "--list-models"], undefined, env)
      expect(scoped.code).toBe(0)
      const scopedParsed = JSON.parse(scoped.stdout)
      expect(
        scopedParsed.data.models.entries.some((e: { model: string }) => e.model === "demo-text"),
      ).toBe(true)

      // task with no supporter on the scoped provider: informative stderr, exit 0
      const empty = await run(
        ["generate", "video2text", "minimax", "--list-models"],
        undefined,
        env,
      )
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
      const r = await run(
        ["generate", "video2text", "minimax", "q", "--input", "a.mp4"],
        undefined,
        env,
      )
      expect(r.code).toBe(2)
      expectErr(r, "E_USAGE", "has no model for video.understand")
      expect(r.stderr).toContain("models that support video2text:")
      expect(r.stderr).toContain("demo/demo-vision")
      expect(r.stderr).toContain("--list-models")

      // explicit model that exists but supports a different capability → warning + suggestions
      const w = await run(["generate", "text2text", "demo/demo-image", "hi"], undefined, env)
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

      const gen = await run(
        ["generate", "text2image", "demo/demo-image", "x", "--no-pack", "--config-dir", configDir],
        undefined,
        env,
      )
      expect(gen.code).toBe(0)
      expect(gen.stdout).toContain("https://cdn.test/out.png")

      const missing = await run(["models", "--config-dir"])
      expect(missing.code).toBe(2)
      expectErr(missing, "E_USAGE", "--config-dir")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("cli -f file-driven — integration", () => {
  it("-f --help prints usage", async () => {
    const { stdout, code } = await run(["-f", "--help"])
    expect(code).toBe(0)
    expect(stdout).toContain("Usage: creatifact -f <file>.json")
  })

  it("runs generate.text2image from a JSON file, CLI flags override fields", async () => {
    const { env, dir, recordPath } = demoEnv()
    const reqPath = path.join(dir, "req.json")
    const resultDir = path.join(dir, "result")
    writeFileSync(
      reqPath,
      JSON.stringify({
        command: "generate.text2image",
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
      expect(parsed.kind).toBe("generate")
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

  it("runs generate.text2video --no-wait and generate.embed from JSON files", async () => {
    const { env, dir } = demoEnv()
    try {
      const videoPath = path.join(dir, "video.json")
      writeFileSync(
        videoPath,
        JSON.stringify({
          command: "generate.text2video",
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
        JSON.stringify({ command: "generate.text2text", provider: "demo", prompt: "hi" }),
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
      const { stdout, code } = await run(["-f", reqPath])
      expect(code).toBe(0)
      expect(stdout).toContain("Built file/test:1.0")
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
        JSON.stringify({ command: "config.set", key: "defaults.gen.provider", value: "demo" }),
      )
      const set = await run(["-f", setPath], undefined, env)
      expect(set.code).toBe(0)
      expect(set.stdout).toContain('"key":"defaults.gen.provider"')

      const get = await run(["config", "get", "defaults.gen.provider"], undefined, env)
      expect(JSON.parse(get.stdout)).toEqual({
        ok: true,
        kind: "config",
        data: { action: "get", key: "defaults.gen.provider", value: "demo" },
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
        JSON.stringify({ command: "generate.text2image", provider: "demo", promp: "x" }),
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

  it("runs a steps pipeline: text2image → image2image with artifact refs", async () => {
    const { env, dir, recordPath } = demoEnv()
    const pipelinePath = path.join(dir, "pipeline.json")
    writeFileSync(
      pipelinePath,
      JSON.stringify({
        steps: [
          {
            name: "s1",
            command: "generate.text2image",
            provider: "demo/demo-image",
            prompt: "a crane",
            output: path.join(dir, "result-1"),
          },
          {
            name: "s2",
            command: "generate.image2image",
            provider: "demo/demo-image",
            prompt: "make it red",
            images: [`\${s1.artifacts[0].url}`],
            output: path.join(dir, "result-2"),
          },
        ],
      }),
    )
    try {
      const r = await run(["-f", pipelinePath], undefined, env)
      expect(r.code, r.stderr).toBe(0)
      expect(r.stderr).toContain("[1/2] s1 · generate.text2image")
      expect(r.stderr).toContain("[2/2] s2 · generate.image2image")

      // the pipeline summary envelope carries every step's data
      const summary = JSON.parse(r.stdout)
      expect(summary.kind).toBe("pipeline")
      expect(summary.data.steps).toHaveLength(2)
      expect(summary.data.steps[0]).toMatchObject({ name: "s1", kind: "generate" })
      expect(summary.data.steps[1].data.artifacts[0].url).toContain("out.png")

      const requests = readFileSync(recordPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(requests).toHaveLength(2)
      expect(requests[1]?.["image"]).toEqual({ url: "https://cdn.test/out.png" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("runs a steps pipeline: text2text → text2image chained on the writer's text", async () => {
    const { env, dir, recordPath } = demoEnv()
    const pipelinePath = path.join(dir, "pipeline.json")
    const resultDir = path.join(dir, "result")
    writeFileSync(
      pipelinePath,
      JSON.stringify({
        steps: [
          {
            name: "writer",
            command: "generate.text2text",
            provider: "demo/demo-text",
            prompt: "write a crane image prompt",
            tag: "demo/writer:v1",
          },
          {
            name: "gen",
            command: "generate.text2image",
            provider: "demo/demo-image",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: pipeline placeholder in a JSON payload string, not a JS template
            prompt: "${writer.text}",
            output: resultDir,
          },
        ],
      }),
    )
    try {
      const r = await run(["-f", pipelinePath], undefined, env)
      expect(r.code, r.stderr).toBe(0)

      const summary = JSON.parse(r.stdout)
      expect(summary.data.steps[0].data.text).toBe("demo text reply")
      // writer packed its text: digest + tag anchor the provenance chain
      expect(summary.data.steps[0].data.tag).toBe("demo/writer:v1")
      expect(summary.data.steps[0].data.digest).toMatch(/^sha256:/)
      expect(summary.data.steps[1].data.outputDir).toBe(resultDir)

      // the image step's prompt IS the text step's generated text
      const requests = readFileSync(recordPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(requests[1]?.["prompt"]).toBe("demo text reply")

      // the image package's config records the digest-anchored promptRef
      const index = JSON.parse(readFileSync(path.join(resultDir, "index.json"), "utf8"))
      const manifest = JSON.parse(
        readFileSync(
          path.join(resultDir, "blobs", "sha256", index.manifests[0].digest.slice(7)),
          "utf8",
        ),
      )
      const config = JSON.parse(
        readFileSync(
          path.join(resultDir, "blobs", "sha256", manifest.config.digest.slice(7)),
          "utf8",
        ),
      )
      expect(config.gen.prompt).toBe("demo text reply")
      expect(config.gen.promptRef).toEqual({
        name: "writer",
        digest: summary.data.steps[0].data.digest,
        tag: "demo/writer:v1",
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("pipeline promptRef records name-only when the text step packed nothing", async () => {
    const { env, dir } = demoEnv()
    const pipelinePath = path.join(dir, "pipeline.json")
    const resultDir = path.join(dir, "result")
    writeFileSync(
      pipelinePath,
      JSON.stringify({
        steps: [
          {
            name: "writer",
            command: "generate.text2text",
            provider: "demo/demo-text",
            prompt: "x",
          },
          {
            name: "gen",
            command: "generate.text2image",
            provider: "demo/demo-image",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: pipeline placeholder in a JSON payload string, not a JS template
            prompt: "${writer.text}",
            output: resultDir,
          },
        ],
      }),
    )
    try {
      const r = await run(["-f", pipelinePath], undefined, env)
      expect(r.code, r.stderr).toBe(0)
      const index = JSON.parse(readFileSync(path.join(resultDir, "index.json"), "utf8"))
      const manifest = JSON.parse(
        readFileSync(
          path.join(resultDir, "blobs", "sha256", index.manifests[0].digest.slice(7)),
          "utf8",
        ),
      )
      const config = JSON.parse(
        readFileSync(
          path.join(resultDir, "blobs", "sha256", manifest.config.digest.slice(7)),
          "utf8",
        ),
      )
      // no digest/tag to anchor: the pointer degrades to the step name only
      expect(config.gen.promptRef).toEqual({ name: "writer" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("pipeline records digest-anchored inputRefs for media chained from a packed step", async () => {
    const { env, dir, recordPath } = demoEnv()
    const pipelinePath = path.join(dir, "pipeline.json")
    const resultDir = path.join(dir, "result")
    writeFileSync(
      pipelinePath,
      JSON.stringify({
        steps: [
          {
            name: "img",
            command: "generate.text2image",
            provider: "demo/demo-image",
            prompt: "a crane",
            tag: "demo/src:v1",
          },
          {
            name: "vid",
            command: "generate.image2video",
            provider: "demo/demo-video",
            prompt: "animate it",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: pipeline placeholder in a JSON payload string, not a JS template
            images: ["${img.artifacts[0].url}"],
            output: resultDir,
          },
        ],
      }),
    )
    try {
      const r = await run(["-f", pipelinePath], undefined, env)
      expect(r.code, r.stderr).toBe(0)
      const summary = JSON.parse(r.stdout)
      const srcDigest = summary.data.steps[0].data.digest
      expect(srcDigest).toMatch(/^sha256:/)

      // the video step actually received the image url
      const requests = readFileSync(recordPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(requests[1]?.["firstFrame"]).toEqual({ url: "https://cdn.test/out.png" })

      // the config records a digest-anchored pointer beside the expiring url
      const index = JSON.parse(readFileSync(path.join(resultDir, "index.json"), "utf8"))
      const manifest = JSON.parse(
        readFileSync(
          path.join(resultDir, "blobs", "sha256", index.manifests[0].digest.slice(7)),
          "utf8",
        ),
      )
      const config = JSON.parse(
        readFileSync(
          path.join(resultDir, "blobs", "sha256", manifest.config.digest.slice(7)),
          "utf8",
        ),
      )
      expect(config.gen.images).toEqual(["https://cdn.test/out.png"])
      expect(config.gen.inputRefs).toEqual([
        { field: "images", index: 0, name: "img", digest: srcDigest, tag: "demo/src:v1" },
      ])
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
        ["generate", "text2image", "demo/ok-image", "a crane", "--tag", "demo/src:v1"],
        undefined,
        env,
      )
      expect(src.code, src.stderr).toBe(0)
      const srcDigest = (JSON.parse(src.stdout) as { data: { digest: string } }).data.digest
      expect(srcDigest).toMatch(/^sha256:/)

      // 2. bake a recipe whose images url will be rejected, with inputRefs anchors
      const recipeDir = path.join(dir, "recipe")
      const manifestPath = path.join(dir, "creatifact-build.json")
      writeFileSync(
        manifestPath,
        JSON.stringify({
          gen: {
            task: "image2image",
            provider: "demo",
            model: "reject-url-image",
            images: [servedUrl],
            inputRefs: [
              { field: "images", index: 0, name: "s1", digest: srcDigest, tag: "demo/src:v1" },
            ],
          },
        }),
      )
      const built = await run([
        "build",
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
      const gen = await run(
        ["generate", recipeDir, "repaint", "--output", resultDir],
        undefined,
        env,
      )
      expect(gen.code, gen.stderr).toBe(0)
      expect(gen.stderr).toContain("retrying with stored bytes")

      const requests = readFileSync(recordPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(requests).toHaveLength(3) // src gen + rejected url + fallback retry
      expect(requests[1]?.["image"]).toEqual({ url: servedUrl })
      const retryImage = requests[2]?.["image"] as { localPath: string } | undefined
      expect(retryImage?.localPath).toMatch(/creatifact-fallback-[\w-]+[/\\]artifact-1\.png$/)

      // provenance keeps the original url + anchors; only execution swapped
      const index = JSON.parse(readFileSync(path.join(resultDir, "index.json"), "utf8"))
      const manifest = JSON.parse(
        readFileSync(
          path.join(resultDir, "blobs", "sha256", index.manifests[0].digest.slice(7)),
          "utf8",
        ),
      )
      const config = JSON.parse(
        readFileSync(
          path.join(resultDir, "blobs", "sha256", manifest.config.digest.slice(7)),
          "utf8",
        ),
      )
      expect(config.gen.images).toEqual([servedUrl])
      expect(config.gen.inputRefs[0].digest).toBe(srcDigest)

      // 4. negative: no inputRefs → the provider error propagates, no retry
      const bareDir = path.join(dir, "recipe-bare")
      const bareManifest = path.join(dir, "creatifact-build-bare.json")
      writeFileSync(
        bareManifest,
        JSON.stringify({
          gen: {
            task: "image2image",
            provider: "demo",
            model: "reject-url-image",
            images: [servedUrl],
          },
        }),
      )
      const bareBuilt = await run(
        ["build", "-f", bareManifest, "-t", "demo/bare:v1", "-o", bareDir],
        undefined,
        env,
      )
      expect(bareBuilt.code, bareBuilt.stderr).toBe(0)
      const bare = await run(["generate", bareDir, "repaint"], undefined, env)
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

  it("rejects steps files: command+steps mix, flag overlay, forward refs", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "creatifact-steps-err-"))
    try {
      const mixed = path.join(dir, "mixed.json")
      writeFileSync(mixed, JSON.stringify({ command: "models", steps: [{ command: "models" }] }))
      const r1 = await run(["-f", mixed])
      expect(r1.code).toBe(2)
      expectErr(r1, "E_USAGE", "cannot have both 'command' and 'steps'")

      const overlay = path.join(dir, "overlay.json")
      writeFileSync(overlay, JSON.stringify({ steps: [{ command: "models" }] }))
      const r2 = await run(["-f", overlay, "--provider", "demo"])
      expect(r2.code).toBe(2)
      expectErr(r2, "E_USAGE", "flags are not supported with a steps file")

      const forward = path.join(dir, "forward.json")
      writeFileSync(
        forward,
        JSON.stringify({
          steps: [
            { name: "a", command: "models" },
            { command: "models", fields: { v: `\${later.x}` } },
          ],
        }),
      )
      const r3 = await run(["-f", forward])
      expect(r3.code).toBe(2)
      expectErr(r3, "E_USAGE", "unknown step 'later'")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
