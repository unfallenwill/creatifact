import { execFileSync, execSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
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
