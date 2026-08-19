import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { test, vi } from "vitest"
import { capabilitiesOf } from "../core/types"
import { createProvider, listConfiguredProviderIds, listProviderIds } from "../index"

const CAPTURING_PLUGIN = `
export const captured = []
export default (settings, env) => {
  captured.push({ settings, env })
  return {
    id: "fixture",
    models: [{ id: "fixture-model", capabilities: {}, lastVerified: "2026-08" }],
    videoGenerate: {
      async submit() { return { providerId: "fixture", id: "t-1" } },
      async poll() { return { state: "pending" } },
    },
  }
}
`

async function makeFixtureDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "creatifact-plugins-"))
}

async function writeConfig(dir: string, config: unknown): Promise<string> {
  const configPath = join(dir, "config.json")
  await writeFile(configPath, JSON.stringify(config))
  return configPath
}

test("loads a plugin from an absolute path", async () => {
  const dir = await makeFixtureDir()
  const pluginPath = join(dir, "fixture.mjs")
  await writeFile(pluginPath, CAPTURING_PLUGIN)
  const configPath = await writeConfig(dir, { providers: { fixture: { module: pluginPath } } })

  try {
    const provider = await createProvider("fixture", { configPath }, {})
    expect(provider.id).toBe("fixture")
    expect(provider.models.map((m) => m.id)).toEqual(["fixture-model"])
    expect(await provider.videoGenerate?.submit({ model: "fixture-model", prompt: "x" })).toEqual({
      providerId: "fixture",
      id: "t-1",
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("resolves a relative plugin path against opts.cwd", async () => {
  const dir = await makeFixtureDir()
  await writeFile(join(dir, "fixture.mjs"), CAPTURING_PLUGIN)
  const configPath = await writeConfig(dir, { providers: { fixture: { module: "./fixture.mjs" } } })

  try {
    const provider = await createProvider("fixture", { configPath, cwd: dir }, {})
    expect(provider.id).toBe("fixture")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

const testUnlessWindows = process.platform === "win32" ? test.skip : test

testUnlessWindows("expands ~/ in plugin paths", async () => {
  const dir = await makeFixtureDir()
  await writeFile(join(dir, "fixture.mjs"), CAPTURING_PLUGIN)
  vi.stubEnv("HOME", dir)
  const configPath = await writeConfig(dir, { providers: { fixture: { module: "~/fixture.mjs" } } })

  try {
    const provider = await createProvider("fixture", { configPath }, {})
    expect(provider.id).toBe("fixture")
  } finally {
    vi.unstubAllEnvs()
    await rm(dir, { recursive: true, force: true })
  }
})

test("falls back to cwd resolution for bare specifiers", async () => {
  const project = await makeFixtureDir()
  const pkgDir = join(project, "node_modules", "creatifact-fixture-pkg")
  await mkdir(pkgDir, { recursive: true })
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "creatifact-fixture-pkg", type: "module", main: "index.mjs" }),
  )
  await writeFile(join(pkgDir, "index.mjs"), CAPTURING_PLUGIN)
  const configPath = await writeConfig(project, {
    providers: { fixture: { module: "creatifact-fixture-pkg" } },
  })

  try {
    const provider = await createProvider("fixture", { configPath, cwd: project }, {})
    expect(provider.id).toBe("fixture")
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})

test("loads a CJS plugin via interop", async () => {
  const dir = await makeFixtureDir()
  await writeFile(
    join(dir, "cjs-fixture.cjs"),
    'module.exports = (settings, env) => ({ id: "cjs-fixture", models: [], embed: { async create() { return { vectors: [] } } } })',
  )
  const configPath = await writeConfig(dir, {
    providers: { "cjs-fixture": { module: join(dir, "cjs-fixture.cjs") } },
  })

  try {
    const provider = await createProvider("cjs-fixture", { configPath }, {})
    expect(provider.id).toBe("cjs-fixture")
    expect(provider.embed).toBeDefined()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("strips module from settings and merges overrides", async () => {
  const dir = await makeFixtureDir()
  const pluginPath = join(dir, "fixture.mjs")
  await writeFile(pluginPath, CAPTURING_PLUGIN)
  const configPath = await writeConfig(dir, {
    providers: { fixture: { module: pluginPath, apiKey: "file-key" } },
  })

  try {
    const env = { FIXTURE_API_KEY: "env-key" }
    await createProvider("fixture", { configPath, settings: { apiKey: "explicit-key" } }, env)
    const mod = (await import(pathToFileURL(pluginPath).href)) as {
      captured: Array<{
        settings: Record<string, unknown>
        env: Record<string, string | undefined>
      }>
    }
    expect(mod.captured).toHaveLength(1)
    const entry = mod.captured[0]
    expect(entry?.settings).toEqual({ apiKey: "explicit-key" })
    expect("module" in (entry?.settings ?? {})).toBe(false)
    expect(entry?.env).toBe(env)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("accepts a programmatic module without any config file", async () => {
  const dir = await makeFixtureDir()
  const pluginPath = join(dir, "fixture.mjs")
  await writeFile(pluginPath, CAPTURING_PLUGIN)

  try {
    const provider = await createProvider(
      "fixture",
      { configPath: join(dir, "missing-config.json"), settings: { module: pluginPath } },
      {},
    )
    expect(provider.id).toBe("fixture")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("rejects plugins whose default export is not a function", async () => {
  const dir = await makeFixtureDir()
  const pluginPath = join(dir, "bad.mjs")
  await writeFile(pluginPath, "export default {}")
  const configPath = await writeConfig(dir, { providers: { fixture: { module: pluginPath } } })

  try {
    await expect(createProvider("fixture", { configPath }, {})).rejects.toThrow(
      /default-export a \(settings, env\) => Provider factory \(got object\)/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("rejects factories that return a non-object", async () => {
  const dir = await makeFixtureDir()
  const pluginPath = join(dir, "str.mjs")
  await writeFile(pluginPath, 'export default () => "nope"')
  const configPath = await writeConfig(dir, { providers: { fixture: { module: pluginPath } } })

  try {
    await expect(createProvider("fixture", { configPath }, {})).rejects.toThrow(
      /must return an object \(got string\)/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("rejects providers whose id mismatches the config key", async () => {
  const dir = await makeFixtureDir()
  const pluginPath = join(dir, "other.mjs")
  await writeFile(
    pluginPath,
    'export default () => ({ id: "other", models: [{ id: "m", capabilities: {}, lastVerified: "2026-08" }], embed: { async create() {} } })',
  )
  const configPath = await writeConfig(dir, { providers: { fixture: { module: pluginPath } } })

  try {
    await expect(createProvider("fixture", { configPath }, {})).rejects.toThrow(
      /declares id 'other' but is configured as 'fixture'/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("rejects providers with no capability APIs", async () => {
  const dir = await makeFixtureDir()
  const pluginPath = join(dir, "bare.mjs")
  await writeFile(pluginPath, 'export default () => ({ id: "fixture", models: [] })')
  const configPath = await writeConfig(dir, { providers: { fixture: { module: pluginPath } } })

  try {
    await expect(createProvider("fixture", { configPath }, {})).rejects.toThrow(
      /none of the capability APIs/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("rejects providers with malformed models entries", async () => {
  const dir = await makeFixtureDir()
  const pluginPath = join(dir, "badmodels.mjs")
  await writeFile(
    pluginPath,
    'export default () => ({ id: "fixture", models: [{ capabilities: {} }], embed: { async create() {} } })',
  )
  const configPath = await writeConfig(dir, { providers: { fixture: { module: pluginPath } } })

  try {
    await expect(createProvider("fixture", { configPath }, {})).rejects.toThrow(
      /provider\.models needs a non-empty string 'id'/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("rejects capability members that are not functions", async () => {
  const dir = await makeFixtureDir()
  const pluginPath = join(dir, "badcap.mjs")
  await writeFile(
    pluginPath,
    'export default () => ({ id: "fixture", models: [], embed: { create: "not-a-function" } })',
  )
  const configPath = await writeConfig(dir, { providers: { fixture: { module: pluginPath } } })

  try {
    await expect(createProvider("fixture", { configPath }, {})).rejects.toThrow(
      /non-function member 'create'/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("rejects capability values that are not objects", async () => {
  const dir = await makeFixtureDir()
  const pluginPath = join(dir, "badapi.mjs")
  await writeFile(pluginPath, 'export default () => ({ id: "fixture", models: [], embed: "foo" })')
  const configPath = await writeConfig(dir, { providers: { fixture: { module: pluginPath } } })

  try {
    await expect(createProvider("fixture", { configPath }, {})).rejects.toThrow(
      /capability 'embed' must be an API object/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("refuses module overrides for built-in providers", async () => {
  const dir = await makeFixtureDir()
  const pluginPath = join(dir, "evil.mjs")
  await writeFile(pluginPath, CAPTURING_PLUGIN)
  const configPath = await writeConfig(dir, { providers: { ark: { module: pluginPath } } })

  try {
    await expect(createProvider("ark", { configPath }, {})).rejects.toThrow(/built-in provider/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("reports missing plugin paths and unresolvable bare specifiers", async () => {
  const dir = await makeFixtureDir()
  const configPath = await writeConfig(dir, {
    providers: {
      fixture: { module: "./missing.mjs" },
      ghost: { module: "creatifact-definitely-not-installed-pkg" },
    },
  })

  try {
    await expect(createProvider("fixture", { configPath, cwd: dir }, {})).rejects.toThrow(
      /cannot load provider module '.\/missing\.mjs'/,
    )
    await expect(createProvider("ghost", { configPath, cwd: dir }, {})).rejects.toThrow(
      /cannot resolve provider module 'creatifact-definitely-not-installed-pkg'/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("unknown ids list configured plugins as available", async () => {
  const dir = await makeFixtureDir()
  const pluginPath = join(dir, "fixture.mjs")
  await writeFile(pluginPath, CAPTURING_PLUGIN)
  const configPath = await writeConfig(dir, { providers: { fixture: { module: pluginPath } } })

  try {
    await expect(createProvider("nope2", { configPath }, {})).rejects.toThrow(
      /unknown provider 'nope2'.*fixture/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("listConfiguredProviderIds unions built-ins and plugin sections", async () => {
  const dir = await makeFixtureDir()
  const pluginPath = join(dir, "fixture.mjs")
  await writeFile(pluginPath, CAPTURING_PLUGIN)
  const configPath = await writeConfig(dir, {
    providers: {
      fixture: { module: pluginPath },
      ark: { apiKey: "plain-settings-section" },
      bare: { apiKey: "no-module-here" },
    },
  })

  try {
    expect(listConfiguredProviderIds({ configPath }).sort()).toEqual([
      "ark",
      "fixture",
      "kling",
      "minimax",
      "zhipu",
    ])
    expect(listProviderIds().sort()).toEqual(["ark", "kling", "minimax", "zhipu"])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a loaded plugin satisfies capabilitiesOf", async () => {
  const dir = await makeFixtureDir()
  const pluginPath = join(dir, "fixture.mjs")
  await writeFile(pluginPath, CAPTURING_PLUGIN)
  const configPath = await writeConfig(dir, { providers: { fixture: { module: pluginPath } } })

  try {
    const provider = await createProvider("fixture", { configPath }, {})
    expect(capabilitiesOf(provider)).toEqual(["video.generate"])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
