import { execSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

const CLI = path.resolve("dist/index.mjs")

beforeAll(() => {
  if (!existsSync(CLI)) execSync("npm run build", { stdio: "inherit" })
})

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
    expect(stdout).toContain("openmmcli -f <file>.json")
    expect(stdout).toContain("gen")
    expect(stdout).toContain("package")
    expect(stdout).toContain("auth")
    expect(stdout).toContain("config")
  })

  it("unknown command errors with usage on stderr", () => {
    const { stderr, code } = run(["frobnicate"])
    expect(code).toBe(1)
    expect(stderr).toContain("unknown command: frobnicate")
  })

  it("package --help and auth --help list actions", () => {
    const pkg = run(["package", "--help"])
    expect(pkg.code).toBe(0)
    expect(pkg.stdout).toContain("Usage: openmmcli package <action>")
    expect(pkg.stdout).toContain("build")

    const auth = run(["auth", "--help"])
    expect(auth.code).toBe(0)
    expect(auth.stdout).toContain("Usage: openmmcli auth <action>")
    expect(auth.stdout).toContain("login")

    const unknown = run(["package", "frobnicate"])
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain("unknown package action 'frobnicate'")
  })
})

describe("cli package build — integration", () => {
  it("build creates valid OCI layout", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "oci-cli-test-"))
    const fixtureDir = path.join(tmp, "fixture")
    const outputDir = path.join(tmp, "output")
    mkdirSync(fixtureDir, { recursive: true })
    writeFileSync(path.join(fixtureDir, "asset.txt"), "test asset content")

    try {
      const { stdout, code } = run([
        "package",
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
    const { stdout, code } = run(["package", "build", "--help"])
    expect(code).toBe(0)
    expect(stdout).toContain("Usage: openmmcli package build")
    expect(stdout).toContain("--tag")
    expect(stdout).toContain("--annotation")
    expect(stdout).toContain("--plain-http")
  })

  it("build -h prints usage and exits 0", () => {
    const { stdout, code } = run(["package", "build", "-h"])
    expect(code).toBe(0)
    expect(stdout).toContain("Usage: openmmcli package build")
  })

  it("build fails when dir does not exist", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "oci-cli-test-"))
    try {
      const { stderr, code } = run([
        "package",
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
      const { stderr, code } = run(["package", "build", "--dir", fixtureDir])
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
    const descPath = path.join(tmp, "openmm-build.json")
    writeFileSync(
      descPath,
      JSON.stringify({
        assets: fixtureDir,
        annotations: { "test.key": "test-value" },
      }),
    )

    try {
      const { stdout, code } = run([
        "package",
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
    const descPath = path.join(tmp, "openmm-build.json")
    writeFileSync(descPath, JSON.stringify({ assets: manifestAssets }))

    try {
      const { code } = run([
        "package",
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
      const first = run([
        "package",
        "build",
        "-t",
        "org/source:1.0.0",
        "--dir",
        sourceDir,
        "-o",
        sourceDir,
      ])
      expect(first.code).toBe(0)

      const descPath = path.join(tmp, "openmm-build.json")
      writeFileSync(descPath, JSON.stringify({ from: sourceDir }))
      const { code } = run([
        "package",
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

  it("build warns about legacy manifest fields and still needs -t", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "oci-cli-test-"))
    const descPath = path.join(tmp, "openmm-build.json")
    writeFileSync(descPath, JSON.stringify({ tag: "old/test:1.0", dir: "./x" }))

    try {
      const { stderr, code } = run(["package", "build", "-f", descPath])
      expect(code).toBe(1)
      expect(stderr).toContain("--tag is required")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe("cli package push — integration", () => {
  it("push --help prints usage and exits 0", () => {
    const { stdout, code } = run(["package", "push", "--help"])
    expect(code).toBe(0)
    expect(stdout).toContain("Usage: openmmcli package push")
    expect(stdout).toContain("--layout")
    expect(stdout).toContain("--plain-http")
  })

  it("push -h prints usage and exits 0", () => {
    const { stdout, code } = run(["package", "push", "-h"])
    expect(code).toBe(0)
    expect(stdout).toContain("Usage: openmmcli package push")
  })

  it("push fails when layout directory does not exist", () => {
    const { stderr, code } = run([
      "package",
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
    const { stdout, code } = run(["package", "pull", "--help"])
    expect(code).toBe(0)
    expect(stdout).toContain("Usage: openmmcli package pull")
  })
})

describe("cli config/auth — integration", () => {
  function configEnv(): { dir: string; env: Record<string, string>; file: string } {
    const dir = mkdtempSync(path.join(tmpdir(), "openmmcli-home-"))
    return { dir, env: { OPENMMCLI_CONFIG_DIR: dir }, file: path.join(dir, "config.json") }
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
  })

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

      const pull = run(["package", "pull", "reg.io/x:1.0"], undefined, env)
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
    expect(stdout).toContain("Usage: openmmcli config")
    expect(stdout).toContain("reset")
  })

  it("auth login --help prints usage", () => {
    const { stdout, code } = run(["auth", "login", "--help"])
    expect(code).toBe(0)
    expect(stdout).toContain("Usage: openmmcli auth login")
  })
})

const DEMO_PLUGIN = `
import { appendFileSync, readFileSync } from "node:fs"
export default (settings, env) => ({
  id: "demo",
  models: [
    { id: "demo-image", capabilities: { "image.generate": {} }, lastVerified: "2026-08" },
    { id: "demo-video", capabilities: { "video.generate": {} }, lastVerified: "2026-08" },
    { id: "demo-stuck", capabilities: { "video.generate": {} }, lastVerified: "2026-08" },
    { id: "demo-vision", capabilities: { "image.understand": {}, "video.understand": {} }, lastVerified: "2026-08" },
    { id: "demo-embed", capabilities: { embed: {} }, lastVerified: "2026-08" },
    { id: "demo-text", capabilities: { "text.generate": {} }, lastVerified: "2026-08" },
  ],
  defaultModels: {
    "text.generate": "demo-text",
    "image.generate": "demo-image",
    "video.generate": "demo-video",
    "image.understand": "demo-vision",
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
  const dir = mkdtempSync(path.join(tmpdir(), "openmmcli-demo-"))
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
  return { env: { OPENMMCLI_CONFIG_DIR: configDir }, dir, recordPath, configPath }
}

describe("cli gen — integration", () => {
  it("gen image runs image generation through a plugin provider", () => {
    const { env, dir, recordPath } = demoEnv()
    try {
      const r = run(["gen", "image", "demo/demo-image", "a crane"], undefined, env)
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("https://cdn.test/out.png")
      expect(readFileSync(recordPath, "utf8")).toContain("a crane")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("gen image without a model uses the provider's default model", () => {
    const { env, dir, recordPath } = demoEnv()
    try {
      const r = run(["gen", "image", "demo", "default crane"], undefined, env)
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("https://cdn.test/out.png")
      const req = JSON.parse(readFileSync(recordPath, "utf8"))
      expect(req.model).toBe("demo-image")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("gen without a provider uses the configured default provider", () => {
    const { env, dir, recordPath, configPath } = demoEnv()
    try {
      const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>
      config["defaults"] = { gen: { provider: "demo" } }
      writeFileSync(configPath, JSON.stringify(config))

      const r = run(["gen", "image", "a crane"], undefined, env)
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("https://cdn.test/out.png")
      expect(readFileSync(recordPath, "utf8")).toContain("a crane")

      const t = run(["gen", "text", "hi"], undefined, env)
      expect(t.code).toBe(0)
      expect(t.stdout).toContain("demo text reply")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("gen text runs chat completion with system prompt", () => {
    const { env, dir, recordPath } = demoEnv()
    try {
      const r = run(
        ["gen", "text", "demo/demo-text", "hello", "--system", "be brief"],
        undefined,
        env,
      )
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("demo text reply")
      const req = JSON.parse(readFileSync(recordPath, "utf8"))
      expect(req).toEqual({
        model: "demo-text",
        prompt: "hello",
        system: "be brief",
        options: {},
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("gen passes typed --opt values to the provider", () => {
    const { env, dir, recordPath } = demoEnv()
    try {
      const r = run(
        ["gen", "image", "demo/demo-image", "x", "--opt", "quality=hd", "--opt", "size=1024x1024"],
        undefined,
        env,
      )
      expect(r.code).toBe(0)
      const req = JSON.parse(readFileSync(recordPath, "utf8"))
      expect(req.options).toEqual({ quality: "hd", size: "1024x1024" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("gen video polls to completion with progress on stderr", () => {
    const { env, dir } = demoEnv()
    try {
      const r = run(["gen", "video", "demo/demo-video", "x", "--interval", "50ms"], undefined, env)
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("https://cdn.test/out.mp4")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("gen video --no-wait prints a single-line handle JSON", () => {
    const { env, dir } = demoEnv()
    try {
      const r = run(["gen", "video", "demo/demo-video", "x", "--no-wait"], undefined, env)
      expect(r.code).toBe(0)
      const lines = r.stdout.trim().split("\n")
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0] ?? "")).toEqual({ providerId: "demo", id: "ok-task" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("gen video surfaces timeout with the task handle for resuming", () => {
    const { env, dir } = demoEnv()
    try {
      const r = run(
        ["gen", "video", "demo/demo-stuck", "x", "--interval", "50ms", "--timeout", "300ms"],
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

  it("gen video rejects missing frame files", () => {
    const { env, dir } = demoEnv()
    try {
      const r = run(
        ["gen", "video", "demo/demo-video", "x", "--first-frame", "/nonexistent.png"],
        undefined,
        env,
      )
      expect(r.code).toBe(1)
      expect(r.stderr).toContain("file not found")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("gen understand asks a question with media attachments", () => {
    const { env, dir, recordPath } = demoEnv()
    try {
      const img = path.join(dir, "cat.png")
      writeFileSync(img, "png")
      const ask = run(
        ["gen", "understand", "demo/demo-vision", "what is this", "--input", img],
        undefined,
        env,
      )
      expect(ask.code).toBe(0)
      expect(ask.stdout).toContain("it is a demo crane")
      const req = JSON.parse(readFileSync(recordPath, "utf8"))
      expect(req.messages[0].content).toEqual(["what is this", { file: { localPath: img } }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("gen embed prints vector summary or --json", () => {
    const { env, dir } = demoEnv()
    try {
      const r = run(["gen", "embed", "demo/demo-embed", "a", "b"], undefined, env)
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("2 vector(s) of 2 dimensions")

      const j = run(["gen", "embed", "demo/demo-embed", "a", "--json"], undefined, env)
      expect(j.code).toBe(0)
      const parsed = JSON.parse(j.stdout) as { capability: string; vectors: number[][] }
      expect(parsed.capability).toBe("embed")
      expect(parsed.vectors).toEqual([[0.1, 0.2]])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("gen notes unverified models and rejects unknown providers", () => {
    const { env, dir } = demoEnv()
    try {
      // Unknown model passes through to the lane's API with a note.
      const pass = run(["gen", "image", "demo/demo-unknown", "x"], undefined, env)
      expect(pass.code).toBe(0)
      expect(pass.stderr).toContain("not in demo's verified list")
      expect(pass.stdout).toContain("https://cdn.test/out.png")

      const unknown = run(["gen", "image", "nope/m", "x"], undefined, env)
      expect(unknown.code).toBe(1)
      expect(unknown.stderr).toContain("unknown provider 'nope'")
      expect(unknown.stderr).toContain("demo")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("gen errors on missing credentials for real providers", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "openmmcli-empty-"))
    try {
      const env = { OPENMMCLI_CONFIG_DIR: dir }
      const r = run(["gen", "image", "zhipu/cogview-4", "x"], undefined, env)
      expect(r.code).toBe(1)
      expect(r.stderr).toContain("missing Zhipu API key")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("gen rejects malformed targets and conflicting prompts", () => {
    const { env, dir } = demoEnv()
    try {
      const noslash = run(["gen", "image", "noslash", "x"], undefined, env)
      expect(noslash.code).toBe(1)
      expect(noslash.stderr).toContain("expected <provider>, got 'noslash'")

      const toomany = run(["gen", "image", "a/b/c", "x"], undefined, env)
      expect(toomany.code).toBe(1)
      expect(toomany.stderr).toContain("expected <provider>[/<model>], got 'a/b/c'")

      const conflict = run(
        ["gen", "image", "demo/demo-image", "pos", "--prompt", "x"],
        undefined,
        env,
      )
      expect(conflict.code).toBe(1)
      expect(conflict.stderr).toContain("mutually exclusive")

      const nolane = run(["gen", "frobnicate"], undefined, env)
      expect(nolane.code).toBe(1)
      expect(nolane.stderr).toContain("unknown gen lane 'frobnicate'")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("gen resume polls from a handle file or inline JSON", () => {
    const { env, dir } = demoEnv()
    try {
      const handleFile = path.join(dir, "job.json")
      writeFileSync(handleFile, JSON.stringify({ providerId: "demo", id: "ok-task" }))
      const r = run(["gen", "resume", handleFile, "--interval", "50ms"], undefined, env)
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("https://cdn.test/out.mp4")

      const inline = run(
        ["gen", "resume", '{"providerId":"demo","id":"ok-task"}', "--interval", "50ms"],
        undefined,
        env,
      )
      expect(inline.code).toBe(0)
      expect(inline.stdout).toContain("out.mp4")

      const bad = run(["gen", "resume", "{broken"], undefined, env)
      expect(bad.code).toBe(1)
      expect(bad.stderr).toContain("not valid JSON")
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
      expect(all.stdout).toContain("6 models")
      expect(all.stderr).toContain("unavailable")

      const one = run(["models", "demo"], undefined, env)
      expect(one.code).toBe(0)
      expect(one.stdout).toContain("demo-image")
      expect(one.stdout).toContain("demo-vision")

      const j = run(["models", "demo", "--json"], undefined, env)
      expect(JSON.parse(j.stdout).models).toHaveLength(6)

      expect(run(["models", "nope"], undefined, env).stderr).toContain("unknown provider")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("gen/models --help print usage", () => {
    const gen = run(["gen", "--help"])
    expect(gen.code).toBe(0)
    expect(gen.stdout).toContain("Usage: openmmcli gen <lane>")
    expect(gen.stdout).toContain("understand")

    for (const lane of ["text", "image", "video", "understand", "embed", "resume"]) {
      const { stdout, code } = run(["gen", lane, "--help"])
      expect(code).toBe(0)
      expect(stdout).toContain(`Usage: openmmcli gen ${lane}`)
    }

    const models = run(["models", "--help"])
    expect(models.code).toBe(0)
    expect(models.stdout).toContain("Usage: openmmcli models")
  })

  it("package build with gen + gen <ref> runs the recipe and packages results", () => {
    const { env, dir, recordPath } = demoEnv()
    const recipeDir = path.join(dir, "recipe")
    const resultDir = path.join(dir, "result")
    const manifestPath = path.join(dir, "openmm-build.json")
    writeFileSync(
      manifestPath,
      JSON.stringify({
        gen: { lane: "image", provider: "demo", model: "demo-image", options: { quality: "hd" } },
      }),
    )
    try {
      const built = run([
        "package",
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
          "gen",
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
      expect(gen.code).toBe(0)
      expect(gen.stdout).toContain("https://cdn.test/out.png")
      expect(gen.stderr).toContain("Built org/result:1.0")

      const req = JSON.parse(readFileSync(recordPath, "utf8"))
      expect(req.prompt).toBe("override crane")
      expect(req.options).toEqual({ quality: "hd", size: "1024x1024" })

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
        lane: "image",
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

  it("gen <ref> materializes pkg:// reference images from package layers", () => {
    const { env, dir, recordPath } = demoEnv()
    const assetsDir = path.join(dir, "assets")
    const recipeDir = path.join(dir, "recipe")
    mkdirSync(assetsDir, { recursive: true })
    writeFileSync(path.join(assetsDir, "ref.png"), "REFIMAGE")
    const manifestPath = path.join(dir, "openmm-build.json")
    writeFileSync(
      manifestPath,
      JSON.stringify({
        gen: { lane: "image", provider: "demo", model: "demo-image", image: "pkg://ref.png" },
        assets: assetsDir,
      }),
    )
    try {
      const built = run([
        "package",
        "build",
        "-f",
        manifestPath,
        "-t",
        "example.com/img2img:v1.0",
        "-o",
        recipeDir,
      ])
      expect(built.code).toBe(0)

      const gen = run(
        ["gen", recipeDir, "paint it", "--output", path.join(dir, "result")],
        undefined,
        env,
      )
      expect(gen.code).toBe(0)
      expect(gen.stdout).toContain("https://cdn.test/out.png")

      const req = JSON.parse(readFileSync(recordPath, "utf8"))
      expect(req.image.localPath).toMatch(/openmm-pkgref-/)
      expect(req.image.localPath).toContain("ref.png")
      expect(req.image.url).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("--config-dir redirects provider and config lookups", () => {
    const { env, dir } = demoEnv()
    const configDir = path.join(dir, "cfg")
    try {
      // No OPENMMCLI_CONFIG_DIR: the flag alone must route config reads.
      const models = run(["models", "--config-dir", configDir])
      expect(models.code).toBe(0)
      expect(models.stdout).toContain("demo  (")
      expect(models.stderr).toContain("unavailable")

      const configPath = run(["config", "path", "--config-dir", configDir])
      expect(configPath.code).toBe(0)
      expect(configPath.stdout.trim()).toBe(path.join(configDir, "config.json"))

      const gen = run(
        ["gen", "image", "demo/demo-image", "x", "--config-dir", configDir],
        undefined,
        env,
      )
      expect(gen.code).toBe(0)
      expect(gen.stdout).toContain("https://cdn.test/out.png")

      const missing = run(["models", "--config-dir"])
      expect(missing.code).toBe(1)
      expect(missing.stderr).toContain("--config-dir requires a directory")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("cli -f file-driven — integration", () => {
  it("-f --help prints usage", () => {
    const { stdout, code } = run(["-f", "--help"])
    expect(code).toBe(0)
    expect(stdout).toContain("Usage: openmmcli -f <file>.json")
  })

  it("runs gen.image from a JSON file with typed options", () => {
    const { env, dir, recordPath } = demoEnv()
    const reqPath = path.join(dir, "req.json")
    writeFileSync(
      reqPath,
      JSON.stringify({
        command: "gen.image",
        provider: "demo/demo-image",
        prompt: "file crane",
        options: { quality: "hd" },
        json: true,
      }),
    )
    try {
      const r = run(["-f", reqPath], undefined, env)
      expect(r.code).toBe(0)
      const parsed = JSON.parse(r.stdout) as { capability: string; artifacts: { url: string }[] }
      expect(parsed.capability).toBe("image.generate")
      expect(parsed.artifacts[0]?.url).toContain("out.png")

      const req = JSON.parse(readFileSync(recordPath, "utf8"))
      expect(req.prompt).toBe("file crane")
      expect(req.options).toEqual({ quality: "hd" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("runs gen.video --no-wait and gen.text from JSON files", () => {
    const { env, dir } = demoEnv()
    try {
      const videoPath = path.join(dir, "video.json")
      writeFileSync(
        videoPath,
        JSON.stringify({ command: "gen.video", provider: "demo", prompt: "x", noWait: true }),
      )
      const v = run(["-f", videoPath], undefined, env)
      expect(v.code).toBe(0)
      expect(JSON.parse(v.stdout.trim())).toEqual({ providerId: "demo", id: "ok-task" })

      const textPath = path.join(dir, "text.json")
      writeFileSync(
        textPath,
        JSON.stringify({ command: "gen.text", provider: "demo", prompt: "hi" }),
      )
      const t = run(["-f", textPath], undefined, env)
      expect(t.code).toBe(0)
      expect(t.stdout).toContain("demo text reply")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("runs package.build from a JSON file", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "oci-file-test-"))
    const fixtureDir = path.join(tmp, "fixture")
    const outputDir = path.join(tmp, "output")
    mkdirSync(fixtureDir, { recursive: true })
    writeFileSync(path.join(fixtureDir, "asset.txt"), "from file")
    const reqPath = path.join(tmp, "req.json")
    writeFileSync(
      reqPath,
      JSON.stringify({
        command: "package.build",
        tag: "file/test:1.0",
        dir: fixtureDir,
        output: outputDir,
        annotations: { "org.openmm.from": "file" },
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
      expect(manifest.annotations["org.openmm.from"]).toBe("file")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("runs auth.login and config.set from JSON files", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "openmmcli-file-auth-"))
    const env = { OPENMMCLI_CONFIG_DIR: dir }
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
    const dir = mkdtempSync(path.join(tmpdir(), "openmmcli-file-err-"))
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
      writeFileSync(typo, JSON.stringify({ command: "gen.image", provider: "demo", promp: "x" }))
      const r3 = run(["-f", typo])
      expect(r3.code).toBe(1)
      expect(r3.stderr).toContain("unknown field 'promp' for command 'gen.image'")

      const missing = run(["-f", path.join(dir, "nope.json")])
      expect(missing.code).toBe(1)
      expect(missing.stderr).toContain("error:")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
