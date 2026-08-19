import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "vitest"
import { createProvider, listProviderIds } from "../index"
import { at, headersOf, jsonResponse, mockFetch } from "./helpers"

let configDir: string

test("createProvider wires config file section, settings override, and env fallback", async () => {
  configDir = await mkdtemp(join(tmpdir(), "creatifact-providers-"))
  const configPath = join(configDir, "config.json")
  await writeFile(
    configPath,
    JSON.stringify({
      providers: {
        ark: { apiKey: "file-key" },
        minimax: { baseUrl: "https://mm.example.test" },
      },
    }),
  )

  try {
    // 1. config file section
    const fromFile = await createProvider("ark", { configPath }, {})
    const mock = mockFetch([() => jsonResponse(200, { id: "t-1" })])
    await fromFile.videoGenerate?.submit({ model: "m", prompt: "x" })
    expect(headersOf(at(mock.recorded, 0))["authorization"]).toBe("Bearer file-key")
    mock.restore()

    // 2. explicit settings beat the config file
    const overridden = await createProvider(
      "ark",
      { configPath, settings: { apiKey: "explicit-key" } },
      {},
    )
    const mock2 = mockFetch([() => jsonResponse(200, { id: "t-2" })])
    await overridden.videoGenerate?.submit({ model: "m", prompt: "x" })
    expect(headersOf(at(mock2.recorded, 0))["authorization"]).toBe("Bearer explicit-key")
    mock2.restore()

    // 3. env fallback when neither config nor settings provide the key
    const fromEnv = await createProvider("minimax", { configPath }, { MINIMAX_API_KEY: "env-key" })
    const mock3 = mockFetch([() => jsonResponse(200, { task_id: "t-3" })])
    await fromEnv.videoGenerate?.submit({
      model: "m",
      prompt: "x",
      options: { resolution: "768P", duration: 6 },
    })
    // baseUrl from config section also applies
    expect(at(mock3.recorded, 0).url).toContain("https://mm.example.test")
    expect(headersOf(at(mock3.recorded, 0))["authorization"]).toBe("Bearer env-key")
    mock3.restore()
  } finally {
    await rm(configDir, { recursive: true })
  }
})

test("createProvider rejects unknown ids and lists available", async () => {
  expect(listProviderIds().sort()).toEqual(["ark", "kling", "minimax", "zhipu"])
  await expect(createProvider("nope")).rejects.toThrow(
    /unknown provider 'nope'.*ark, kling, minimax, zhipu/,
  )
})

test("createProvider surfaces corrupt config loudly", async () => {
  configDir = await mkdtemp(join(tmpdir(), "creatifact-providers-"))
  const configPath = join(configDir, "config.json")
  await writeFile(configPath, "{ broken")

  try {
    await expect(createProvider("ark", { configPath }, {})).rejects.toThrow(/corrupt/)
  } finally {
    await rm(configDir, { recursive: true })
  }
})

test("createProvider injects config models declarations and expands env refs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prov-models-"))
  try {
    const configPath = join(dir, "config.json")
    writeFileSync(
      configPath,
      JSON.stringify({
        providers: { minimax: { apiKey: `$` + `{MY_MM_KEY}` } },
        models: {
          minimax: [
            {
              id: "MiniMax-H4",
              mode: "v2",
              capabilities: { "video.generate": { textOnly: true } },
            },
          ],
        },
      }),
    )
    const provider = await createProvider("minimax", { configPath }, { MY_MM_KEY: "sk-live" })
    const h4 = provider.models.find((m) => m.id === "MiniMax-H4")
    expect(h4?.source).toBe("custom")

    // env expansion: the key resolves, so instantiation succeeds; wrong env → auth error
    const broken = await createProvider("minimax", { configPath }, {}).catch((e: Error) => e)
    expect(broken).toBeInstanceOf(Error)
    expect((broken as Error).message).toContain("missing MiniMax API key")

    // bad declaration on one provider errors loudly through createProvider
    writeFileSync(configPath, JSON.stringify({ models: { minimax: [{ id: "X", mode: "v3" }] } }))
    await expect(
      createProvider("minimax", { configPath }, { MY_MM_KEY: "sk-live" }),
    ).rejects.toThrow(/unknown mode 'v3'/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
