import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "vitest"
import { createProvider, listProviderIds } from "../index"
import { at, headersOf, jsonResponse, mockFetch } from "./helpers"

let configDir: string

test("createProvider wires config file section, settings override, and env fallback", async () => {
  configDir = await mkdtemp(join(tmpdir(), "openmmcli-providers-"))
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
  configDir = await mkdtemp(join(tmpdir(), "openmmcli-providers-"))
  const configPath = join(configDir, "config.json")
  await writeFile(configPath, "{ broken")

  try {
    await expect(createProvider("ark", { configPath }, {})).rejects.toThrow(/corrupt/)
  } finally {
    await rm(configDir, { recursive: true })
  }
})
