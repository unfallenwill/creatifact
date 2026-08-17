import { randomBytes } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const CONFIG_VERSION = 1

/**
 * Docker-compatible registry credential entry.
 * - `auth` is base64("username:password"), matching ~/.docker/config.json "auths".
 * - `identitytoken` is reserved for registry-issued tokens (not used yet).
 * - `insecure` marks the registry as plain-HTTP without a CLI flag.
 */
export interface RegistryAuthEntry {
  auth?: string
  identitytoken?: string
  username?: string
  insecure?: boolean
}

/**
 * Root config object stored at ~/.openmmcli/config.json (or $OPENMMCLI_CONFIG_DIR).
 * Unknown sections (e.g. "providers" used by the providers module) are preserved
 * on load/save, so multiple features share one file safely.
 */
export interface OpenmmCliConfig {
  version?: number
  providers?: Record<string, Record<string, unknown>>
  auths?: Record<string, RegistryAuthEntry>
  [key: string]: unknown
}

export class ConfigError extends Error {}

export function configDir(env: Record<string, string | undefined> = process.env): string {
  const override = env["OPENMMCLI_CONFIG_DIR"]
  return override && override !== "" ? override : join(homedir(), ".openmmcli")
}

export function configPath(env: Record<string, string | undefined> = process.env): string {
  return join(configDir(env), "config.json")
}

export function loadConfig(path?: string): OpenmmCliConfig {
  const file = path ?? configPath()
  let raw: string
  try {
    raw = readFileSync(file, "utf8")
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === "ENOENT") return {}
    throw new ConfigError(`cannot read config file ${file}: ${err.message}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new ConfigError(
      `config file is corrupt: ${file} (${(e as Error).message}). ` +
        "Fix it manually or run: openmmcli config reset",
    )
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(
      `config file is corrupt: ${file} (expected a JSON object). ` +
        "Fix it manually or run: openmmcli config reset",
    )
  }
  return parsed as OpenmmCliConfig
}

/** Atomic write: tmp file + rename in the same directory, best-effort 0600. */
export function saveConfig(config: OpenmmCliConfig, path?: string): void {
  const file = path ?? configPath()
  mkdirSync(dirname(file), { recursive: true })
  const tmp = join(
    dirname(file),
    `.config.json.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  )
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`)
  try {
    chmodSync(tmp, 0o600)
  } catch {
    // Best effort only (e.g. no-op on some filesystems/Windows).
  }
  try {
    renameSync(tmp, file)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw new ConfigError(`cannot write config file ${file}: ${(e as Error).message}`)
  }
}

export function deleteConfig(path?: string): boolean {
  const file = path ?? configPath()
  if (!existsSync(file)) return false
  rmSync(file)
  return true
}

/** Strip scheme and trailing slashes, lowercase — "https://Foo.io/" → "foo.io". */
export function normalizeRegistry(registry: string): string {
  return registry
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .toLowerCase()
}

const REGISTRY_RE = /^[a-z0-9._-]+(:\d+)?$/

export function isValidRegistry(registry: string): boolean {
  return REGISTRY_RE.test(normalizeRegistry(registry))
}

export function encodeAuth(username: string, password: string): string {
  return Buffer.from(`${username}:${password}`).toString("base64")
}

export function decodeAuth(auth: string): { username: string; password: string } {
  const decoded = Buffer.from(auth, "base64").toString("utf8")
  const idx = decoded.indexOf(":")
  if (idx < 0 || decoded.slice(0, idx) === "") {
    throw new ConfigError('stored "auth" value is malformed (expected base64 "user:password")')
  }
  return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) }
}

export function getRegistryEntry(
  config: OpenmmCliConfig,
  registry: string,
): RegistryAuthEntry | undefined {
  return config.auths?.[normalizeRegistry(registry)]
}

/** Default gen provider: config key `defaults.gen.provider` (e.g. "zhipu"). */
export function defaultGenProvider(config: OpenmmCliConfig): string | undefined {
  const defaults = config["defaults"]
  if (typeof defaults !== "object" || defaults === null) return undefined
  const gen = (defaults as Record<string, unknown>)["gen"]
  if (typeof gen !== "object" || gen === null) return undefined
  const provider = (gen as Record<string, unknown>)["provider"]
  return typeof provider === "string" && provider !== "" ? provider : undefined
}

/**
 * Credential resolution order:
 *   1. complete CLI pair (--username AND --password/--password-stdin)
 *   2. config.json auths entry for that registry
 *   3. none (anonymous)
 */
export function resolveRegistryCredentials(
  registry: string,
  cliUsername: string | undefined,
  cliPassword: string | undefined,
  config: OpenmmCliConfig,
): { username: string; password: string } | undefined {
  if (cliUsername !== undefined && cliPassword !== undefined) {
    return { username: cliUsername, password: cliPassword }
  }
  const entry = getRegistryEntry(config, registry)
  if (entry?.auth !== undefined) {
    return decodeAuth(entry.auth)
  }
  return undefined
}

/** --plain-http wins; otherwise a registry's "insecure" flag applies. */
export function resolvePlainHttp(
  registry: string,
  cliPlainHttp: boolean,
  config: OpenmmCliConfig,
): boolean {
  if (cliPlainHttp) return true
  return getRegistryEntry(config, registry)?.insecure === true
}

const RESERVED_KEYS = new Set(["version"])

export function getConfigValue(
  config: OpenmmCliConfig,
  key: string,
): { found: boolean; value: unknown } {
  const parts = key.split(".")
  let current: unknown = config
  for (const part of parts) {
    if (typeof current !== "object" || current === null) {
      return { found: false, value: undefined }
    }
    current = (current as Record<string, unknown>)[part]
  }
  return { found: true, value: current }
}

export function setConfigValue(config: OpenmmCliConfig, key: string, value: unknown): void {
  const parts = key.split(".")
  if (parts.some((p) => p === "")) {
    throw new ConfigError(`invalid config key: ${key}`)
  }
  if (RESERVED_KEYS.has(parts[0] ?? "")) {
    throw new ConfigError(`'${parts[0]}' is reserved and cannot be set manually`)
  }
  let current: Record<string, unknown> = config
  for (const part of parts.slice(0, -1)) {
    const next = current[part]
    if (next === undefined) {
      const created: Record<string, unknown> = {}
      current[part] = created
      current = created
    } else if (typeof next === "object" && next !== null && !Array.isArray(next)) {
      current = next as Record<string, unknown>
    } else {
      throw new ConfigError(`config key '${key}' conflicts with non-object value at '${part}'`)
    }
  }
  current[parts[parts.length - 1] ?? ""] = value
}

const SECRET_KEYS = new Set([
  "auth",
  "identitytoken",
  "password",
  "apikey",
  "secretkey",
  "accesskey",
])

/** Recursively mask secret-looking values so `config list` output is safe to share. */
export function maskForPrint(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(maskForPrint)
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.has(k.toLowerCase()) && typeof v === "string" ? "***" : maskForPrint(v)
    }
    return out
  }
  return value
}
