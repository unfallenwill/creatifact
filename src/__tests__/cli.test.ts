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

describe("cli build — integration", () => {
  it("build creates valid OCI layout", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "oci-cli-test-"))
    const fixtureDir = path.join(tmp, "fixture")
    const outputDir = path.join(tmp, "output")
    mkdirSync(fixtureDir, { recursive: true })
    writeFileSync(path.join(fixtureDir, "plugin.txt"), "test plugin content")

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
    writeFileSync(path.join(fixtureDir, "plugin.txt"), "from desc file")
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
