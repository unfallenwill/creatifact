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

function run(args: string[], input?: string): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      ...(input === undefined ? {} : { input }),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
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
})

describe("cli pack — integration", () => {
  it("pack creates valid OCI layout", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "oci-cli-test-"))
    const fixtureDir = path.join(tmp, "fixture")
    const outputDir = path.join(tmp, "output")
    mkdirSync(fixtureDir, { recursive: true })
    writeFileSync(path.join(fixtureDir, "plugin.txt"), "test plugin content")

    try {
      const { stdout, code } = run([
        "pack",
        "--dir",
        fixtureDir,
        "--name",
        "test/fixture:1.0.0",
        "-o",
        outputDir,
      ])

      expect(code).toBe(0)
      expect(stdout).toContain("Packed")
      expect(existsSync(path.join(outputDir, "oci-layout"))).toBe(true)
      expect(existsSync(path.join(outputDir, "index.json"))).toBe(true)
      expect(existsSync(path.join(outputDir, "blobs", "sha256"))).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("pack --help prints usage and exits 0", () => {
    const { stdout, code } = run(["pack", "--help"])
    expect(code).toBe(0)
    expect(stdout).toContain("Usage: openmmcli pack")
    expect(stdout).toContain("--name")
    expect(stdout).toContain("--annotation")
  })

  it("pack -h prints usage and exits 0", () => {
    const { stdout, code } = run(["pack", "-h"])
    expect(code).toBe(0)
    expect(stdout).toContain("Usage: openmmcli pack")
  })

  it("pack fails when dir does not exist", () => {
    const { stderr, code } = run(["pack", "--dir", "/nonexistent/path/xyz", "--name", "test:1.0"])
    expect(code).toBe(1)
    expect(stderr).toContain("does not exist")
  })

  it("pack fails when name is missing", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "oci-cli-test-"))
    const fixtureDir = path.join(tmp, "fixture")
    mkdirSync(fixtureDir, { recursive: true })
    writeFileSync(path.join(fixtureDir, "file.txt"), "data")

    try {
      const { stderr, code } = run(["pack", "--dir", fixtureDir])
      expect(code).toBe(1)
      expect(stderr).toContain("--name")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("pack with description file", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "oci-cli-test-"))
    const fixtureDir = path.join(tmp, "fixture")
    const outputDir = path.join(tmp, "output")
    mkdirSync(fixtureDir, { recursive: true })
    writeFileSync(path.join(fixtureDir, "plugin.txt"), "from desc file")
    const descPath = path.join(tmp, "openmm-pack.json")
    writeFileSync(
      descPath,
      JSON.stringify({
        name: "desc/test:2.0.0",
        dir: fixtureDir,
        annotations: { "test.key": "test-value" },
      }),
    )

    try {
      const { stdout, code } = run(["pack", "-f", descPath, "-o", outputDir])

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
