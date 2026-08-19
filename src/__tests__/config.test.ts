import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import {
  ConfigError,
  configPath,
  decodeAuth,
  deleteConfig,
  encodeAuth,
  encodeBasicAuth,
  envForConfigPath,
  getConfigValue,
  isValidRegistry,
  loadConfig,
  maskForPrint,
  normalizeRegistry,
  resolvePlainHttp,
  resolveRegistryCredentials,
  saveConfig,
  setConfigValue,
  storeDir,
  toCredentials,
} from "../config"

function tmpConfigPath(): string {
  return join(mkdtempSync(join(tmpdir(), "creatifact-config-")), "config.json")
}

test("configPath honors CREATIFACT_CONFIG_DIR", () => {
  expect(configPath({ CREATIFACT_CONFIG_DIR: "/tmp/x" })).toBe(join("/tmp/x", "config.json"))
  expect(configPath({})).toBe(join(homedir(), ".creatifact", "config.json"))
})

test("loadConfig returns empty object when file is missing", () => {
  expect(loadConfig(tmpConfigPath())).toEqual({})
})

test("loadConfig throws ConfigError on malformed JSON with path and hint", () => {
  const dir = mkdtempSync(join(tmpdir(), "creatifact-config-"))
  const path = join(dir, "config.json")
  writeFileSync(path, "{ not json")

  try {
    expect(() => loadConfig(path)).toThrow(ConfigError)
    expect(() => loadConfig(path)).toThrow(/corrupt/)
    expect(() => loadConfig(path)).toThrow(path)
    expect(() => loadConfig(path)).toThrow("creatifact config reset")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("loadConfig throws on non-object root", () => {
  const dir = mkdtempSync(join(tmpdir(), "creatifact-config-"))
  const path = join(dir, "config.json")
  writeFileSync(path, "[1,2]")

  try {
    expect(() => loadConfig(path)).toThrow(ConfigError)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("saveConfig writes atomically, preserves unknown sections, leaves no tmp files", () => {
  const dir = mkdtempSync(join(tmpdir(), "creatifact-config-"))
  const path = join(dir, "config.json")

  try {
    saveConfig({ providers: { ark: { apiKey: "k" } } }, path)
    const config = loadConfig(path)
    config.auths = { "localhost:5000": { auth: encodeAuth("u", "p") } }
    saveConfig(config, path)

    const reloaded = loadConfig(path)
    expect(reloaded.providers).toEqual({ ark: { apiKey: "k" } })
    const entry = reloaded.auths?.["localhost:5000"]
    expect(entry?.auth).toBeDefined()
    expect(decodeAuth(entry?.auth ?? "")).toEqual({ username: "u", password: "p" })

    const files = readdirSync(dir)
    expect(files).toEqual(["config.json"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("deleteConfig returns false when absent, true when removed", () => {
  const dir = mkdtempSync(join(tmpdir(), "creatifact-config-"))
  const path = join(dir, "config.json")

  try {
    expect(deleteConfig(path)).toBe(false)
    writeFileSync(path, "{}")
    expect(deleteConfig(path)).toBe(true)
    expect(loadConfig(path)).toEqual({})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("encodeAuth/decodeAuth roundtrip", () => {
  const auth = encodeAuth("user", "p@ss:with:colons")
  expect(decodeAuth(auth)).toEqual({ username: "user", password: "p@ss:with:colons" })
})

test("decodeAuth rejects malformed values", () => {
  const noColon = Buffer.from("useronly").toString("base64")
  expect(() => decodeAuth(noColon)).toThrow(ConfigError)
})

test("normalizeRegistry strips scheme, slashes, lowercases", () => {
  expect(normalizeRegistry("https://Registry.Example.COM/")).toBe("registry.example.com")
  expect(normalizeRegistry("localhost:5000")).toBe("localhost:5000")
})

test("isValidRegistry accepts hosts and host:port, rejects refs", () => {
  expect(isValidRegistry("localhost:5000")).toBe(true)
  expect(isValidRegistry("https://reg.example.com")).toBe(true)
  expect(isValidRegistry("reg.example.com")).toBe(true)
  expect(isValidRegistry("reg.example.com/my/repo")).toBe(false)
  expect(isValidRegistry("repo:1.0")).toBe(false) // non-numeric port — treated as a ref, rejected
})

test("resolveRegistryCredentials: complete CLI pair wins over config", () => {
  const config = { auths: { "reg.io": { auth: encodeAuth("cfg", "cfgpw") } } }
  expect(resolveRegistryCredentials("reg.io", "cli", "clipw", config)).toEqual({
    username: "cli",
    password: "clipw",
  })
})

test("resolveRegistryCredentials: falls back to config when CLI pair incomplete", () => {
  const config = { auths: { "reg.io": { auth: encodeAuth("cfg", "cfgpw") } } }
  expect(resolveRegistryCredentials("reg.io", "cli-only", undefined, config)).toEqual({
    username: "cfg",
    password: "cfgpw",
  })
  expect(resolveRegistryCredentials("reg.io", undefined, undefined, config)).toEqual({
    username: "cfg",
    password: "cfgpw",
  })
})

test("resolveRegistryCredentials: anonymous when nothing matches", () => {
  expect(resolveRegistryCredentials("reg.io", undefined, undefined, {})).toBeUndefined()
  expect(
    resolveRegistryCredentials("reg.io", undefined, undefined, { auths: { "other.io": {} } }),
  ).toBeUndefined()
})

test("resolveRegistryCredentials normalizes registry lookup", () => {
  const config = { auths: { "reg.io": { auth: encodeAuth("u", "p") } } }
  expect(resolveRegistryCredentials("https://REG.io/", undefined, undefined, config)).toEqual({
    username: "u",
    password: "p",
  })
})

test("resolvePlainHttp: CLI flag wins, then config insecure", () => {
  const config = { auths: { "reg.io": { insecure: true } } }
  expect(resolvePlainHttp("reg.io", true, {})).toBe(true)
  expect(resolvePlainHttp("reg.io", false, config)).toBe(true)
  expect(resolvePlainHttp("reg.io", false, {})).toBe(false)
})

test("getConfigValue walks dotted paths", () => {
  const config = { auths: { "localhost:5000": { username: "dev" } } }
  expect(getConfigValue(config, "auths.localhost:5000.username")).toEqual({
    found: true,
    value: "dev",
  })
  expect(getConfigValue(config, "auths.missing.username")).toEqual({
    found: false,
    value: undefined,
  })
})

test("setConfigValue creates intermediates and rejects reserved keys", () => {
  const config: Record<string, unknown> = {}
  setConfigValue(config, "providers.ark.baseUrl", "https://x")
  expect(config).toEqual({ providers: { ark: { baseUrl: "https://x" } } })

  expect(() => setConfigValue(config, "version", 2)).toThrow(ConfigError)
  expect(() => setConfigValue({ a: "str" }, "a.b", 1)).toThrow(/conflicts/)
})

test("maskForPrint hides secret-looking values, keeps the rest", () => {
  const masked = maskForPrint({
    version: 1,
    auths: { "reg.io": { auth: "c2VjcmV0", username: "u", identitytoken: "t" } },
    providers: { ark: { apiKey: "k", baseUrl: "https://x" } },
  }) as Record<string, unknown>

  const auths = masked["auths"] as Record<string, Record<string, unknown>>
  expect(auths["reg.io"]?.["auth"]).toBe("***")
  expect(auths["reg.io"]?.["identitytoken"]).toBe("***")
  expect(auths["reg.io"]?.["username"]).toBe("u")

  const providers = masked["providers"] as Record<string, Record<string, unknown>>
  expect(providers["ark"]?.["apiKey"]).toBe("***")
  expect(providers["ark"]?.["baseUrl"]).toBe("https://x")
  expect(masked["version"]).toBe(1)
})

test("toCredentials requires a complete pair; encodeBasicAuth reuses encodeAuth", () => {
  expect(toCredentials("u", undefined)).toBeUndefined()
  expect(toCredentials(undefined, "p")).toBeUndefined()
  expect(toCredentials("u", "p")).toEqual({ username: "u", password: "p" })
  expect(encodeBasicAuth({ username: "u", password: "p" })).toBe(
    `Basic ${Buffer.from("u:p").toString("base64")}`,
  )
})

test("storeDir lives under the config dir", () => {
  const env = { CREATIFACT_CONFIG_DIR: "/cfg" }
  expect(storeDir(env)).toBe(join("/cfg", "store"))
  expect(storeDir()).toBe(join(homedir(), ".creatifact", "store"))
})

test("envForConfigPath prefers the explicit config dir", () => {
  expect(envForConfigPath(undefined)).toBe(process.env)
  expect(envForConfigPath("/x/config.json")).toEqual({ CREATIFACT_CONFIG_DIR: "/x" })
})
