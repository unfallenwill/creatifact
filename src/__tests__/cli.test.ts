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
    expect(stdout).toContain("Usage: openmmcli <command>")
    expect(stdout).toContain("login")
    expect(stdout).toContain("config")
  })

  it("unknown command errors with usage on stderr", () => {
    const { stderr, code } = run(["frobnicate"])
    expect(code).toBe(1)
    expect(stderr).toContain("unknown command: frobnicate")
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
    expect(stdout).toContain("Usage: openmmcli build")
    expect(stdout).toContain("--tag")
    expect(stdout).toContain("--annotation")
    expect(stdout).toContain("--plain-http")
  })

  it("build -h prints usage and exits 0", () => {
    const { stdout, code } = run(["build", "-h"])
    expect(code).toBe(0)
    expect(stdout).toContain("Usage: openmmcli build")
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

      const descPath = path.join(tmp, "openmm-build.json")
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
    const descPath = path.join(tmp, "openmm-build.json")
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
    expect(stdout).toContain("Usage: openmmcli push")
    expect(stdout).toContain("--layout")
    expect(stdout).toContain("--plain-http")
  })

  it("push -h prints usage and exits 0", () => {
    const { stdout, code } = run(["push", "-h"])
    expect(code).toBe(0)
    expect(stdout).toContain("Usage: openmmcli push")
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
})

describe("cli config/login/logout — integration", () => {
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

  it("login --password-stdin writes docker-compatible auths, get/list/logout work", () => {
    const { dir, env, file } = configEnv()
    try {
      const login = run(
        ["login", "localhost:5000", "-u", "testuser", "--password-stdin"],
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

      const logout = run(["logout", "localhost:5000"], undefined, env)
      expect(logout.code).toBe(0)

      const gone = run(["config", "get", "auths.localhost:5000.username"], undefined, env)
      expect(gone.code).toBe(1)
      expect(gone.stderr).toContain("not found")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("login normalizes registry and logout errors when not logged in", () => {
    const { dir, env } = configEnv()
    try {
      const login = run(["login", "https://REG.example.com/", "-u", "u", "-p", "p"], undefined, env)
      expect(login.code).toBe(0)
      expect(login.stdout).toContain("Login succeeded (reg.example.com)")

      const again = run(["logout", "reg.example.com"], undefined, env)
      expect(again.code).toBe(0)

      const notLoggedIn = run(["logout", "reg.example.com"], undefined, env)
      expect(notLoggedIn.code).toBe(1)
      expect(notLoggedIn.stderr).toContain("Not logged in")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("login without registry or username fails", () => {
    const { dir, env } = configEnv()
    try {
      const noRegistry = run(["login"], undefined, env)
      expect(noRegistry.code).toBe(1)
      expect(noRegistry.stderr).toContain("requires a <registry>")

      const noUser = run(["login", "reg.io", "--password-stdin"], "pw\n", env)
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
    expect(stdout).toContain("Usage: openmmcli config")
    expect(stdout).toContain("reset")
  })

  it("login --help prints usage", () => {
    const { stdout, code } = run(["login", "--help"])
    expect(code).toBe(0)
    expect(stdout).toContain("Usage: openmmcli login")
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
  ],
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

function demoEnv(): { env: Record<string, string>; dir: string; recordPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "openmmcli-demo-"))
  const pluginPath = path.join(dir, "demo.mjs")
  const recordPath = path.join(dir, "requests.log")
  writeFileSync(pluginPath, DEMO_PLUGIN)
  const configDir = path.join(dir, "cfg")
  mkdirSync(configDir)
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ providers: { demo: { module: pluginPath, recordPath } } }),
  )
  return { env: { OPENMMCLI_CONFIG_DIR: configDir }, dir, recordPath }
}

describe("cli gen/models/jobs — integration", () => {
  it("gen runs image generation through a plugin provider", () => {
    const { env, dir, recordPath } = demoEnv()
    try {
      const r = run(["gen", "demo/demo-image", "--prompt", "a crane"], undefined, env)
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("https://cdn.test/out.png")
      expect(readFileSync(recordPath, "utf8")).toContain("a crane")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("gen passes typed --opt values to the provider", () => {
    const { env, dir, recordPath } = demoEnv()
    try {
      const r = run(
        [
          "gen",
          "demo/demo-image",
          "--prompt",
          "x",
          "--opt",
          "quality=hd",
          "--opt",
          "size=1024x1024",
        ],
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

  it("gen polls video to completion with progress on stderr", () => {
    const { env, dir } = demoEnv()
    try {
      const r = run(
        ["gen", "demo/demo-video", "--prompt", "x", "--interval", "50ms"],
        undefined,
        env,
      )
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("https://cdn.test/out.mp4")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("gen --no-wait prints a single-line handle JSON", () => {
    const { env, dir } = demoEnv()
    try {
      const r = run(["gen", "demo/demo-video", "--prompt", "x", "--no-wait"], undefined, env)
      expect(r.code).toBe(0)
      const lines = r.stdout.trim().split("\n")
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0] ?? "")).toEqual({ providerId: "demo", id: "ok-task" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("gen surfaces timeout with the task handle for resuming", () => {
    const { env, dir } = demoEnv()
    try {
      const r = run(
        ["gen", "demo/demo-stuck", "--prompt", "x", "--interval", "50ms", "--timeout", "300ms"],
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

  it("gen rejects missing frame files", () => {
    const { env, dir } = demoEnv()
    try {
      const r = run(
        ["gen", "demo/demo-video", "--prompt", "x", "--first-frame", "/nonexistent.png"],
        undefined,
        env,
      )
      expect(r.code).toBe(1)
      expect(r.stderr).toContain("file not found")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("gen disambiguates multi-capability models via --ask and --input", () => {
    const { env, dir, recordPath } = demoEnv()
    try {
      const ambiguous = run(["gen", "demo/demo-vision", "--prompt", "x"], undefined, env)
      expect(ambiguous.code).toBe(1)
      expect(ambiguous.stderr).toContain("multiple lanes")

      const img = path.join(dir, "cat.png")
      writeFileSync(img, "png")
      const ask = run(
        ["gen", "demo/demo-vision", "--ask", "what is this", "--input", img],
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

  it("gen runs embed and prints vector summary or --json", () => {
    const { env, dir } = demoEnv()
    try {
      const r = run(["gen", "demo/demo-embed", "--input", "a", "--input", "b"], undefined, env)
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("2 vector(s) of 2 dimensions")

      const j = run(["gen", "demo/demo-embed", "--input", "a", "--json"], undefined, env)
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
      // Unknown model passes through to the provider's full API set; with two
      // generate capabilities --prompt alone cannot disambiguate.
      const pass = run(["gen", "demo/demo-unknown", "--prompt", "x"], undefined, env)
      expect(pass.code).toBe(1)
      expect(pass.stderr).toContain("not in demo's verified list")
      expect(pass.stderr).toContain("multiple lanes")

      const unknown = run(["gen", "nope/m", "--prompt", "x"], undefined, env)
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
      const r = run(["gen", "zhipu/cogview-4", "--prompt", "x"], undefined, env)
      expect(r.code).toBe(1)
      expect(r.stderr).toContain("missing Zhipu API key")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("gen rejects malformed targets and conflicting triggers", () => {
    const { env, dir } = demoEnv()
    try {
      expect(run(["gen", "noslash", "--prompt", "x"], undefined, env).stderr).toContain(
        "expected <provider>/<model>",
      )
      expect(
        run(["gen", "a/b/c", "--prompt", "x"], undefined, env).code === 0 ? "" : "err",
      ).toBeTruthy()
      expect(
        run(["gen", "demo/demo-image", "--prompt", "x", "--ask", "y"], undefined, env).stderr,
      ).toContain("mutually exclusive")
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
      expect(all.stdout).toContain("5 models")
      expect(all.stderr).toContain("unavailable")

      const one = run(["models", "demo"], undefined, env)
      expect(one.code).toBe(0)
      expect(one.stdout).toContain("demo-image")
      expect(one.stdout).toContain("demo-vision")

      const j = run(["models", "demo", "--json"], undefined, env)
      expect(JSON.parse(j.stdout).models).toHaveLength(5)

      expect(run(["models", "nope"], undefined, env).stderr).toContain("unknown provider")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("jobs resumes polling from a handle file or inline JSON", () => {
    const { env, dir } = demoEnv()
    try {
      const handleFile = path.join(dir, "job.json")
      writeFileSync(handleFile, JSON.stringify({ providerId: "demo", id: "ok-task" }))
      const r = run(["jobs", handleFile, "--interval", "50ms"], undefined, env)
      expect(r.code).toBe(0)
      expect(r.stdout).toContain("https://cdn.test/out.mp4")

      const inline = run(
        ["jobs", '{"providerId":"demo","id":"ok-task"}', "--interval", "50ms"],
        undefined,
        env,
      )
      expect(inline.code).toBe(0)
      expect(inline.stdout).toContain("out.mp4")

      const bad = run(["jobs", "{broken"], undefined, env)
      expect(bad.code).toBe(1)
      expect(bad.stderr).toContain("not valid JSON")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("gen/models/jobs --help print usage", () => {
    for (const cmd of ["gen", "models", "jobs"]) {
      const { stdout, code } = run([cmd, "--help"])
      expect(code).toBe(0)
      expect(stdout).toContain(`Usage: openmmcli ${cmd}`)
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
        ["gen", "demo/demo-image", "--prompt", "x", "--config-dir", configDir],
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
