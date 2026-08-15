import { execFileSync, execSync } from "node:child_process"
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
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      ...(input === undefined ? {} : { input }),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
    })
    return { stdout, stderr: "", code: 0 }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number }
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.status ?? null }
  }
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
