import { execSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

const CLI = path.resolve("dist/index.mjs")

beforeAll(() => {
  if (!existsSync(CLI)) execSync("npm run build", { stdio: "inherit" })
})

// spawnSync blocks the worker IPC loop; yield between cases so Vitest can flush task updates.
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)))

interface RunResult {
  stdout: string
  stderr: string
  code: number | null
}

function run(args: string[], input?: string, env?: Record<string, string>): RunResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    ...(input === undefined ? {} : { input }),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  })
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.status }
}

describe("cli — integration", () => {
  it("--version prints the package version and exits 0", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string }
    const { stdout, code } = run(["--version"])
    expect(code).toBe(0)
    expect(stdout.trim()).toBe(pkg.version)
  })

  it("bare invocation prints usage and exits 0", () => {
    const { stdout, code } = run([])
    expect(code).toBe(0)
    expect(stdout).toContain("creatifact -f <file>.json")
    expect(stdout).toContain("gen")
    expect(stdout).toContain("build")
    expect(stdout).toContain("auth")
    expect(stdout).toContain("config")
  })

  it("unknown command errors with usage on stderr", () => {
    const { stderr, code } = run(["frobnicate"])
    expect(code).toBe(1)
    expect(stderr).toContain("unknown command: frobnicate")
  })

  it("build/push/pull --help list options; unknown top-level fails", () => {
    const build = run(["build", "--help"])
    expect(build.code).toBe(0)
    expect(build.stdout).toContain("Usage: creatifact build")

    const auth = run(["auth", "--help"])
    expect(auth.code).toBe(0)
    expect(auth.stdout).toContain("Usage: creatifact auth <action>")
    expect(auth.stdout).toContain("login")

    const unknown = run(["frobnicate"])
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain("unknown command: frobnicate")
  })
})

describe("cli build — integration", () => {
  it("build creates valid OCI layout", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "oci-cli-test-"))
    const fixtureDir = path.join(tmp, "fixture")
    const outputDir = path.join(tmp, "output")
    mkdirSync(fixtureDir, { recursive: true })
    writeFileSync(path.join(fixtureDir, "asset.txt"), "test asset content")

    try {
      const { stdout, code } = run([
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

  it("build --help prints usage and exits 0", () => {
    const { stdout, code } = run(["build", "--help"])
    expect(code).toBe(0)
    expect(stdout).toContain("Usage: creatifact build")
    expect(stdout).toContain("--tag")
    expect(stdout).toContain("--annotation")
    expect(stdout).toContain("--plain-http")
  })

  it("build -h prints usage and exits 0", () => {
    const { stdout, code } = run(["build", "-h"])
    expect(code).toBe(0)
    expect(stdout).toContain("Usage: creatifact build")
  })

  it("build fails when dir does not exist", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "oci-cli-test-"))
    try {
      const { stderr, code } = run([
        "build",
        "--dir",
        "/nonexistent/path/xyz",
        "-t",
        "test:1.0",
        "-o",
        path.join(tmp, "out"),
      ])
      expect(code).toBe(1)
      expect(stderr).toContain("does not exist")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("build fails when tag is missing", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "oci-cli-test-"))
    const fixtureDir = path.join(tmp, "fixture")
    mkdirSync(fixtureDir, { recursive: true })
    writeFileSync(path.join(fixtureDir, "file.txt"), "data")

    try {
      const { stderr, code } = run(["build", "--dir", fixtureDir])
      expect(code).toBe(1)
      expect(stderr).toContain("--tag")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("build with manifest assets and CLI tag", () => {
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
      const { stdout, code } = run([
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

  it("build --dir overrides manifest assets", () => {
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
      const { code } = run([
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

  it("build inherits from a local OCI layout", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "oci-cli-test-"))
    const sourceDir = path.join(tmp, "source")
    const outputDir = path.join(tmp, "output")

    try {
      const first = run(["build", "-t", "org/source:1.0.0", "--dir", sourceDir, "-o", sourceDir])
      expect(first.code).toBe(0)

      const descPath = path.join(tmp, "creatifact-build.json")
      writeFileSync(descPath, JSON.stringify({ from: sourceDir }))
      const { code } = run(["build", "-f", descPath, "-t", "org/combined:1.0.0", "-o", outputDir])
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

  it("build warns about legacy manifest fields and still needs -t", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "oci-cli-test-"))
    const descPath = path.join(tmp, "creatifact-build.json")
    writeFileSync(descPath, JSON.stringify({ tag: "old/test:1.0", dir: "./x" }))

    try {
      const { stderr, code } = run(["build", "-f", descPath])
      expect(code).toBe(1)
      expect(stderr).toContain("--tag is required")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe("cli push — integration", () => {
  it("push --help prints usage and exits 0", () => {
    const { stdout, code } = run(["push", "--help"])
    expect(code).toBe(0)
    expect(stdout).toContain("Usage: creatifact push")
    expect(stdout).toContain("--layout")
    expect(stdout).toContain("--plain-http")
  })

  it("push -h prints usage and exits 0", () => {
    const { stdout, code } = run(["push", "-h"])
    expect(code).toBe(0)
    expect(stdout).toContain("Usage: creatifact push")
  })

  it("push fails when layout directory does not exist", () => {
    const { stderr, code } = run([
      "push",
      "localhost:5000/test:1.0",
      "--layout",
      "/nonexistent/path/xyz",
      "--plain-http",
    ])
    expect(code).toBe(1)
    expect(stderr).toContain("error:")
  })

  it("pull --help prints usage and exits 0", () => {
    const { stdout, code } = run(["pull", "--help"])
    expect(code).toBe(0)
    expect(stdout).toContain("Usage: creatifact pull")
  })
})

describe("cli models — custom declarations", () => {
  it("lists custom models with a marker; rejects unknown provider keys", () => {
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
      const r = run(["models", "minimax"], undefined, env)
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("MiniMax-H4 (custom)  video.generate  next gen")
      expect(r.stdout).toContain("MiniMax-H3  video.generate  gw override")

      // unknown provider key in models config → hard error
      writeFileSync(
        path.join(configDir, "config.json"),
        JSON.stringify({ models: { volcengine: [{ id: "x" }] } }),
      )
      const bad = run(["models"], undefined, env)
      expect(bad.code).toBe(1)
      expect(bad.stderr).toContain("unknown provider 'volcengine'")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe("cli package store — integration", () => {
  it("package ls lists tags; package rm untags and GCs blobs", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "oci-cli-rm-"))
    const configDir = path.join(tmp, "cfg")
    const fixture = path.join(tmp, "assets")
    mkdirSync(configDir, { recursive: true })
    mkdirSync(fixture, { recursive: true })
    writeFileSync(path.join(fixture, "a.txt"), "hello")
    const env = { CREATIFACT_CONFIG_DIR: configDir }
    try {
      run(["build", "--dir", fixture, "-t", "demo/a:1"], undefined, env)
      run(["build", "--dir", fixture, "-t", "demo/b:1"], undefined, env)

      const viaPkg = run(["package", "ls"], undefined, env)
      expect(viaPkg.code).toBe(0)
      expect(viaPkg.stdout).toContain("demo/a:1")

      // rm one tag: shared blobs survive
      const r1 = run(["package", "rm", "demo/a:1"], undefined, env)
      expect(r1.code).toBe(0)
      expect(r1.stdout).toContain("Untagged: demo/a:1")
      expect(r1.stdout).not.toContain("Deleted:")
      const after = run(["package", "ls"], undefined, env)
      expect(after.stdout).toContain("demo/b:1")
      expect(after.stdout).not.toContain("demo/a:1")

      // rm the last tag: blobs collected
      const r2 = run(["package", "rm", "demo/b:1"], undefined, env)
      expect(r2.stdout).toContain("Deleted: sha256:")
      const empty = run(["package", "ls"], undefined, env)
      expect(empty.stdout).toContain("Store is empty")

      // rm of a missing tag fails cleanly
      const r3 = run(["package", "rm", "nope:1"], undefined, env)
      expect(r3.code).toBe(1)
      expect(r3.stderr).toContain("not found in store")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("package ls lists store tags after builds; rebuild replaces the same tag", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "oci-cli-store-"))
    const configDir = path.join(tmp, "cfg")
    const fixture = path.join(tmp, "assets")
    mkdirSync(configDir, { recursive: true })
    mkdirSync(fixture, { recursive: true })
    writeFileSync(path.join(fixture, "a.txt"), "hello")
    const env = { CREATIFACT_CONFIG_DIR: configDir }
    try {
      const r1 = run(["build", "--dir", fixture, "-t", "demo/one:1"], undefined, env)
      expect(r1.code).toBe(0)
      expect(r1.stdout).toContain("store")

      const r2 = run(["build", "--dir", fixture, "-t", "demo/two:1"], undefined, env)
      expect(r2.code).toBe(0)

      const ls = run(["package", "ls"], undefined, env)
      expect(ls.code).toBe(0)
      expect(ls.stdout).toContain("demo/one:1")
      expect(ls.stdout).toContain("demo/two:1")

      // re-tag demo/one:1 → still one entry per tag, index keeps both tags
      const r3 = run(["build", "--dir", fixture, "-t", "demo/one:1"], undefined, env)
      expect(r3.code).toBe(0)
      const index = JSON.parse(readFileSync(path.join(configDir, "store", "index.json"), "utf8"))
      expect(index.manifests).toHaveLength(2)

      // push of an unknown store tag fails with a helpful message
      const push = run(["push", "nope/missing:1"], undefined, env)
      expect(push.code).toBe(1)
      expect(push.stderr + push.stdout).toMatch(/not found in|no image layout/)
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

  it("config path prints the config file location", () => {
    const { dir, env, file } = configEnv()
    try {
      const { stdout, code } = run(["config", "path"], undefined, env)
      expect(code).toBe(0)
      expect(stdout.trim()).toBe(file)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("auth login --password-stdin writes docker-compatible auths, get/list/logout work", () => {
    const { dir, env, file } = configEnv()
    try {
      const login = run(
        ["auth", "login", "localhost:5000", "-u", "testuser", "--password-stdin"],
        "testpass\n",
        env,
      )
      expect(login.code).toBe(0)
      expect(login.stdout).toContain("Login succeeded")

      const config = JSON.parse(readFileSync(file, "utf8")) as {
        auths: Record<string, { auth: string; username: string }>
      }
      const expected = Buffer.from("testuser:testpass").toString("base64")
      expect(config.auths["localhost:5000"]).toEqual({ auth: expected, username: "testuser" })

      const get = run(["config", "get", "auths.localhost:5000.username"], undefined, env)
      expect(get.code).toBe(0)
      expect(get.stdout.trim()).toBe("testuser")

      const getSecret = run(["config", "get", "auths.localhost:5000.auth"], undefined, env)
      expect(getSecret.code).toBe(0)
      expect(getSecret.stdout.trim()).toBe("***")

      const list = run(["config", "list"], undefined, env)
      expect(list.code).toBe(0)
      expect(list.stdout).toContain("***")
      expect(list.stdout).not.toContain("testpass")

      const logout = run(["auth", "logout", "localhost:5000"], undefined, env)
      expect(logout.code).toBe(0)

      const gone = run(["config", "get", "auths.localhost:5000.username"], undefined, env)
      expect(gone.code).toBe(1)
      expect(gone.stderr).toContain("not found")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)

  it("auth login normalizes registry and logout errors when not logged in", () => {
    const { dir, env } = configEnv()
    try {
      const login = run(
        ["auth", "login", "https://REG.example.com/", "-u", "u", "-p", "p"],
        undefined,
        env,
      )
      expect(login.code).toBe(0)
      expect(login.stdout).toContain("Login succeeded (reg.example.com)")

      const again = run(["auth", "logout", "reg.example.com"], undefined, env)
      expect(again.code).toBe(0)

      const notLoggedIn = run(["auth", "logout", "reg.example.com"], undefined, env)
      expect(notLoggedIn.code).toBe(1)
      expect(notLoggedIn.stderr).toContain("Not logged in")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("auth login without registry or username fails", () => {
    const { dir, env } = configEnv()
    try {
      const noRegistry = run(["auth", "login"], undefined, env)
      expect(noRegistry.code).toBe(1)
      expect(noRegistry.stderr).toContain("requires a <registry>")

      const noUser = run(["auth", "login", "reg.io", "--password-stdin"], "pw\n", env)
      expect(noUser.code).toBe(1)
      expect(noUser.stderr).toContain("--username")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("config set/get/reset roundtrip and reserved key rejection", () => {
    const { dir, env, file } = configEnv()
    try {
      const set = run(
        ["config", "set", "providers.ark.baseUrl", "https://ark.example.com"],
        undefined,
        env,
      )
      expect(set.code).toBe(0)

      const get = run(["config", "get", "providers.ark.baseUrl"], undefined, env)
      expect(get.code).toBe(0)
      expect(get.stdout.trim()).toBe("https://ark.example.com")

      const reserved = run(["config", "set", "version", "2"], undefined, env)
      expect(reserved.code).toBe(1)
      expect(reserved.stderr).toContain("reserved")

      const reset = run(["config", "reset"], undefined, env)
      expect(reset.code).toBe(0)
      expect(existsSync(file)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("corrupt config file fails loudly and config reset recovers", () => {
    const { dir, env, file } = configEnv()
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(file, "{ broken json")

      const pull = run(["pull", "reg.io/x:1.0"], undefined, env)
      expect(pull.code).toBe(1)
      expect(pull.stderr).toContain("corrupt")
      expect(pull.stderr).toContain("config reset")

      const reset = run(["config", "reset"], undefined, env)
      expect(reset.code).toBe(0)
      expect(run(["config", "path"], undefined, env).code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("config --help prints usage", () => {
    const { stdout, code } = run(["config", "--help"])
    expect(code).toBe(0)
    expect(stdout).toContain("Usage: creatifact config")
    expect(stdout).toContain("reset")
  })

  it("auth login --help prints usage", () => {
    const { stdout, code } = run(["auth", "login", "--help"])
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
  it("text2text runs chat completion with system prompt", () => {
    const { env, dir, recordPath } = demoEnv()
    try {
      const r = run(
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

  it("text2image uses the provider's declared default model", () => {
    const { env, dir, recordPath } = demoEnv()
    try {
      const r = run(
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

  it("image2image requires --image and picks the imageInput model", () => {
    const { env, dir, recordPath } = demoEnv()
    try {
      const missing = run(["generate", "image2image", "demo", "x"], undefined, env)
      expect(missing.code).toBe(1)
      expect(missing.stderr).toContain("image2image requires --image")

      const img = path.join(dir, "cat.png")
      writeFileSync(img, "png")
      const r = run(
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

  it("text2video rejects --first-frame with guidance to image2video", () => {
    const { env, dir } = demoEnv()
    try {
      const r = run(
        ["generate", "text2video", "demo", "x", "--first-frame", "/nonexistent.png"],
        undefined,
        env,
      )
      expect(r.code).toBe(1)
      expect(r.stderr).toContain("text2video does not take --first-frame")
      expect(r.stderr).toContain("image2video")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("image2video maps --image to the first frame and packages results", () => {
    const { env, dir, recordPath } = demoEnv()
    const resultDir = path.join(dir, "result")
    try {
      const img = path.join(dir, "first.png")
      writeFileSync(img, "f")
      const r = run(
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
      expect(r.stderr).toContain("Built org/v:1")
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

  it("frames2video requires both frames and submits them", () => {
    const { env, dir, recordPath } = demoEnv()
    try {
      const missing = run(
        ["generate", "frames2video", "demo", "x", "--first-frame", "a.png"],
        undefined,
        env,
      )
      expect(missing.code).toBe(1)
      expect(missing.stderr).toContain("requires --last-frame")

      const a = path.join(dir, "a.png")
      const b = path.join(dir, "b.png")
      writeFileSync(a, "a")
      writeFileSync(b, "b")
      const r = run(
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

  it("frames2video with an explicit model bypasses the strict filter", () => {
    const { env, dir } = demoEnv()
    try {
      const a = path.join(dir, "a.png")
      const b = path.join(dir, "b.png")
      writeFileSync(a, "a")
      writeFileSync(b, "b")
      const r = run(
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
      expect(JSON.parse(r.stdout.trim())).toEqual({ providerId: "demo", id: "stuck-task" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("image2text and video2text ask questions with attachments", () => {
    const { env, dir, recordPath } = demoEnv()
    try {
      const img = path.join(dir, "cat.png")
      writeFileSync(img, "png")
      const ask = run(
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

      const vid = run(
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

  it("embed prints vector summary or --json", () => {
    const { env, dir } = demoEnv()
    try {
      const r = run(["generate", "embed", "demo/demo-embed", "a", "b"], undefined, env)
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("2 vector(s) of 2 dimensions")

      const j = run(["generate", "embed", "demo/demo-embed", "a", "--json"], undefined, env)
      expect(j.code).toBe(0)
      const parsed = JSON.parse(j.stdout) as { capability: string; vectors: number[][] }
      expect(parsed.capability).toBe("embed")
      expect(parsed.vectors).toEqual([[0.1, 0.2]])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("video tasks print a handle with --no-wait and resume polls it", () => {
    const { env, dir } = demoEnv()
    try {
      const r = run(["generate", "text2video", "demo/demo-video", "x", "--no-wait"], undefined, env)
      expect(r.code).toBe(0)
      const lines = r.stdout.trim().split("\n")
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0] ?? "")).toEqual({ providerId: "demo", id: "ok-task" })

      const handleFile = path.join(dir, "job.json")
      writeFileSync(handleFile, JSON.stringify({ providerId: "demo", id: "ok-task" }))
      const resumed = run(["generate", "resume", handleFile, "--interval", "50ms"], undefined, env)
      expect(resumed.code).toBe(0)
      expect(resumed.stdout).toContain("out.mp4")

      const inline = run(
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

  it("video polling timeout surfaces the task handle", () => {
    const { env, dir } = demoEnv()
    try {
      const r = run(
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
      expect(r.code).toBe(1)
      expect(r.stderr).toContain("timed out")
      expect(r.stderr).toContain('"providerId":"demo"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("generate without a provider uses the configured default provider", () => {
    const { env, dir, recordPath, configPath } = demoEnv()
    try {
      const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>
      config["defaults"] = { gen: { provider: "demo" } }
      writeFileSync(configPath, JSON.stringify(config))

      const r = run(["generate", "text2image", "a crane", "--no-pack"], undefined, env)
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("https://cdn.test/out.png")
      expect(lastRequest(recordPath)["prompt"]).toBe("a crane")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("gen is an alias for generate", () => {
    const { env, dir } = demoEnv()
    try {
      const r = run(["gen", "text2image", "demo", "x", "--no-pack"], undefined, env)
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("https://cdn.test/out.png")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("unknown tasks and unverified models behave predictably", () => {
    const { env, dir } = demoEnv()
    try {
      const unknown = run(["generate", "frobnicate"], undefined, env)
      expect(unknown.code).toBe(1)
      expect(unknown.stderr).toContain("unknown generate task 'frobnicate'")

      const pass = run(
        ["generate", "text2image", "demo/demo-unknown", "x", "--no-pack"],
        undefined,
        env,
      )
      expect(pass.code).toBe(0)
      expect(pass.stdout).toContain("https://cdn.test/out.png")

      const unknownProvider = run(["generate", "text2image", "nope/m", "x"], undefined, env)
      expect(unknownProvider.code).toBe(1)
      expect(unknownProvider.stderr).toContain("unknown provider 'nope'")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("--model <provider>/<model> shorthand resolves the provider too", () => {
    const { env, dir, recordPath } = demoEnv()
    try {
      const r = run(
        ["generate", "text2image", "a crane", "--model", "demo/demo-image", "--no-pack"],
        undefined,
        env,
      )
      expect(r.code).toBe(0)
      const last = lastRequest(recordPath)
      expect(last["model"]).toBe("demo-image")
      expect(r.stderr).not.toContain("no <provider> given")

      // bare --model without provider still needs a default provider
      const bare = run(
        ["generate", "text2image", "a crane", "--model", "demo-image", "--no-pack"],
        undefined,
        env,
      )
      expect(bare.code).toBe(1)
      expect(bare.stderr).toContain("no <provider> given")
      expect(bare.stderr).toContain("--model <provider>/<model>")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("errors on missing credentials for real providers", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "creatifact-empty-"))
    try {
      const env = { CREATIFACT_CONFIG_DIR: dir }
      const r = run(["generate", "text2image", "zhipu/cogview-4", "x"], undefined, env)
      expect(r.code).toBe(1)
      expect(r.stderr).toContain("missing Zhipu API key")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("generate --help prints usage and each task has help", () => {
    const gen = run(["generate", "--help"])
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
      const { stdout, code } = run(["generate", task, "--help"])
      expect(code).toBe(0)
      expect(stdout).toContain(`Usage: creatifact generate ${task}`)
    }
  }, 15_000)

  it("build with gen + generate <ref> runs the recipe and packages results", () => {
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
      const built = run([
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

      const gen = run(
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
      expect(gen.stderr).toContain("Built org/result:1.0")

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

  it("generate <ref> materializes pkg:// reference images from package layers", () => {
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
      const built = run([
        "build",
        "-f",
        manifestPath,
        "-t",
        "example.com/img2img:v1.0",
        "-o",
        recipeDir,
      ])
      expect(built.code).toBe(0)

      const gen = run(["generate", recipeDir, "paint it", "--output", resultDir], undefined, env)
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

  it("models lists providers, plugin details, and errors on unknown", () => {
    const { env, dir } = demoEnv()
    try {
      const all = run(["models"], undefined, env)
      expect(all.code).toBe(0)
      expect(all.stdout).toContain("demo  (")
      expect(all.stderr).toContain("unavailable")

      const one = run(["models", "demo"], undefined, env)
      expect(one.code).toBe(0)
      expect(one.stdout).toContain("demo-image")
      expect(one.stdout).toContain("demo-vision")

      const j = run(["models", "demo", "--json"], undefined, env)
      expect(JSON.parse(j.stdout).models).toHaveLength(7)

      expect(run(["models", "nope"], undefined, env).stderr).toContain("unknown provider")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("--config-dir redirects provider and config lookups", () => {
    const { env, dir } = demoEnv()
    const configDir = path.join(dir, "cfg")
    try {
      // No CREATIFACT_CONFIG_DIR: the flag alone must route config reads.
      const models = run(["models", "--config-dir", configDir])
      expect(models.code).toBe(0)
      expect(models.stdout).toContain("demo  (")
      expect(models.stderr).toContain("unavailable")

      const configPath = run(["config", "path", "--config-dir", configDir])
      expect(configPath.code).toBe(0)
      expect(configPath.stdout.trim()).toBe(path.join(configDir, "config.json"))

      const gen = run(
        ["generate", "text2image", "demo/demo-image", "x", "--no-pack", "--config-dir", configDir],
        undefined,
        env,
      )
      expect(gen.code).toBe(0)
      expect(gen.stdout).toContain("https://cdn.test/out.png")

      const missing = run(["models", "--config-dir"])
      expect(missing.code).toBe(1)
      expect(missing.stderr).toContain("--config-dir")
      expect(missing.stderr).toContain("argument missing")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("cli -f file-driven — integration", () => {
  it("-f --help prints usage", () => {
    const { stdout, code } = run(["-f", "--help"])
    expect(code).toBe(0)
    expect(stdout).toContain("Usage: creatifact -f <file>.json")
  })

  it("runs generate.text2image from a JSON file, CLI flags override fields", () => {
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
        json: true,
      }),
    )
    try {
      // File-only run
      const r = run(["-f", reqPath, "--output", resultDir], undefined, env)
      expect(r.code).toBe(0)
      const parsed = JSON.parse(r.stdout) as { capability: string; artifacts: { url: string }[] }
      expect(parsed.capability).toBe("image.generate")
      expect(parsed.artifacts[0]?.url).toContain("out.png")

      const req = lastRequest(recordPath)
      expect(req["prompt"]).toBe("file crane")
      expect(req["options"]).toEqual({ quality: "hd" })

      // CLI positional prompt + --opt override the file's fields
      const overridden = run(
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

  it("runs generate.text2video --no-wait and generate.embed from JSON files", () => {
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
      const v = run(["-f", videoPath], undefined, env)
      expect(v.code).toBe(0)
      expect(JSON.parse(v.stdout.trim())).toEqual({ providerId: "demo", id: "ok-task" })

      const textPath = path.join(dir, "text.json")
      writeFileSync(
        textPath,
        JSON.stringify({ command: "generate.text2text", provider: "demo", prompt: "hi" }),
      )
      const t = run(["-f", textPath], undefined, env)
      expect(t.code).toBe(0)
      expect(t.stdout).toContain("demo text reply")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("runs build from a JSON file", () => {
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
      const { stdout, code } = run(["-f", reqPath])
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

  it("runs auth.login and config.set from JSON files", () => {
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
      const login = run(["-f", loginPath], undefined, env)
      expect(login.code).toBe(0)
      expect(login.stdout).toContain("Login succeeded")

      const setPath = path.join(dir, "set.json")
      writeFileSync(
        setPath,
        JSON.stringify({ command: "config.set", key: "defaults.gen.provider", value: "demo" }),
      )
      const set = run(["-f", setPath], undefined, env)
      expect(set.code).toBe(0)
      expect(set.stdout).toContain("Set defaults.gen.provider")

      const get = run(["config", "get", "defaults.gen.provider"], undefined, env)
      expect(get.stdout.trim()).toBe("demo")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects bad JSON, unknown commands, and unknown fields", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "creatifact-file-err-"))
    try {
      const badJson = path.join(dir, "bad.json")
      writeFileSync(badJson, "{ oops")
      const r1 = run(["-f", badJson])
      expect(r1.code).toBe(1)
      expect(r1.stderr).toContain("not valid JSON")

      const unknown = path.join(dir, "unknown.json")
      writeFileSync(unknown, JSON.stringify({ command: "frobnicate" }))
      const r2 = run(["-f", unknown])
      expect(r2.code).toBe(1)
      expect(r2.stderr).toContain("unknown command 'frobnicate'")

      const typo = path.join(dir, "typo.json")
      writeFileSync(
        typo,
        JSON.stringify({ command: "generate.text2image", provider: "demo", promp: "x" }),
      )
      const r3 = run(["-f", typo])
      expect(r3.code).toBe(1)
      expect(r3.stderr).toContain("unknown field 'promp' for command 'generate.text2image'")

      const missing = run(["-f", path.join(dir, "nope.json")])
      expect(missing.code).toBe(1)
      expect(missing.stderr).toContain("error:")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("runs a steps pipeline: text2image → image2image with artifact refs", () => {
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
      const r = run(["-f", pipelinePath], undefined, env)
      expect(r.code, r.stderr).toBe(0)
      expect(r.stderr).toContain("[1/2] s1 · generate.text2image")
      expect(r.stderr).toContain("[2/2] s2 · generate.image2image")

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

  it("rejects steps files: command+steps mix, flag overlay, forward refs", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "creatifact-steps-err-"))
    try {
      const mixed = path.join(dir, "mixed.json")
      writeFileSync(mixed, JSON.stringify({ command: "models", steps: [{ command: "models" }] }))
      const r1 = run(["-f", mixed])
      expect(r1.code).toBe(1)
      expect(r1.stderr).toContain("cannot have both 'command' and 'steps'")

      const overlay = path.join(dir, "overlay.json")
      writeFileSync(overlay, JSON.stringify({ steps: [{ command: "models" }] }))
      const r2 = run(["-f", overlay, "--json"])
      expect(r2.code).toBe(1)
      expect(r2.stderr).toContain("flags are not supported with a steps file")

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
      const r3 = run(["-f", forward])
      expect(r3.code).toBe(1)
      expect(r3.stderr).toContain("unknown step 'later'")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
