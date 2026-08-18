import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, expect, test } from "vitest"
import { executeCommand } from "../execute"

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "openmm-execute-"))
}

describe("executeCommand", () => {
  let dir: string
  let configPath: string

  beforeEach(() => {
    dir = tmpDir()
    configPath = join(dir, "config.json")
    writeFileSync(configPath, JSON.stringify({ version: 1 }))
  })

  test("config path action returns void and prints the file", async () => {
    await expect(
      executeCommand({ kind: "config", action: "path", rest: [] }, { configPath }),
    ).resolves.toEqual({ kind: "void" })
    rmSync(dir, { recursive: true, force: true })
  })

  test("build returns digest/outputDir/tag", async () => {
    const output = join(dir, "out")
    const result = await executeCommand(
      {
        kind: "build",
        req: {
          tag: "org/x:1.0.0",
          output,
          annotations: {},
          passwordStdin: false,
          plainHttp: false,
        },
      },
      { configPath },
    )
    expect(result.kind).toBe("build")
    if (result.kind !== "build") return
    expect(result.tag).toBe("org/x:1.0.0")
    expect(result.outputDir).toBe(output)
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    const index = JSON.parse(readFileSync(join(output, "index.json"), "utf8"))
    expect(index.manifests[0].digest).toBe(result.digest)
    rmSync(dir, { recursive: true, force: true })
  })

  test("config get masks secret leaves", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({ version: 1, auths: { "localhost:5000": { auth: "eHg=" } } }),
    )
    await expect(
      executeCommand(
        { kind: "config", action: "get", rest: ["auths.localhost:5000.auth"] },
        { configPath },
      ),
    ).resolves.toEqual({ kind: "void" })
    rmSync(dir, { recursive: true, force: true })
  })

  test("models lists providers through the dispatch point", async () => {
    await expect(
      executeCommand(
        { kind: "models", req: { provider: "definitely-not-a-provider", json: false } },
        { configPath },
      ),
    ).rejects.toThrow(/no provider|unknown/i)
    rmSync(dir, { recursive: true, force: true })
  })
})
