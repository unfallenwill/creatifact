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
 * Root config object stored at ~/.creatifact/config.json (or $CREATIFACT_CONFIG_DIR).
 * Unknown sections (e.g. "providers" used by the providers module) are preserved
 * on load/save, so multiple features share one file safely.
 */
/** One user-declared model entry under models.<providerId> (validated in the providers layer). */
export interface ModelDeclaration {
  id: string
  /** Provider protocol mode (e.g. minimax "v2"|"t2v"|"i2v"|"fl2v"|"s2v"; required for video models on mode-table providers). */
  mode?: string
  capabilities?: Record<string, Record<string, unknown>>
  note?: string
}

export interface CreatifactConfig {
  version?: number
  providers?: Record<string, Record<string, unknown>>
  /** User model declarations per provider id: append unknown ids, override known ones. */
  models?: Record<string, ModelDeclaration[]>
  auths?: Record<string, RegistryAuthEntry>
  [key: string]: unknown
}

export class ConfigError extends Error {}

export function configDir(env: Record<string, string | undefined> = process.env): string {
  const override = env["CREATIFACT_CONFIG_DIR"]
  return override && override !== "" ? override : join(homedir(), ".creatifact")
}

export function configPath(env: Record<string, string | undefined> = process.env): string {
  return join(configDir(env), "config.json")
}

/**
 * Env view that honors an explicit --config-dir (as configPath) over
 * CREATIFACT_CONFIG_DIR, for path helpers shared by run functions.
 */
export function envForConfigPath(
  configPath: string | undefined,
): Record<string, string | undefined> {
  return configPath === undefined ? process.env : { CREATIFACT_CONFIG_DIR: dirname(configPath) }
}

/**
 * Shared content store: one OCI layout holding every built/pulled/generated
 * image, blobs deduped by digest and tags as index pointers (docker-style).
 */
export function storeDir(env: Record<string, string | undefined> = process.env): string {
  return join(configDir(env), "store")
}

export function loadConfig(path?: string): CreatifactConfig {
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
        "Fix it manually or run: creatifact config reset",
    )
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(
      `config file is corrupt: ${file} (expected a JSON object). ` +
        "Fix it manually or run: creatifact config reset",
    )
  }
  return parsed as CreatifactConfig
}

/** Atomic write: tmp file + rename in the same directory, best-effort 0600. */
export function saveConfig(config: CreatifactConfig, path?: string): void {
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

export interface Credentials {
  username: string
  password: string
}

export function toCredentials(
  username: string | undefined,
  password: string | undefined,
): Credentials | undefined {
  return username && password ? { username, password } : undefined
}

export function encodeBasicAuth(creds: Credentials): string {
  return `Basic ${encodeAuth(creds.username, creds.password)}`
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
  config: CreatifactConfig,
  registry: string,
): RegistryAuthEntry | undefined {
  return config.auths?.[normalizeRegistry(registry)]
}

/** Default gen provider: config key `defaults.gen.provider` (e.g. "zhipu"). */
export function defaultGenProvider(config: CreatifactConfig): string | undefined {
  const defaults = config["defaults"]
  if (typeof defaults !== "object" || defaults === null) return undefined
  const gen = (defaults as Record<string, unknown>)["gen"]
  if (typeof gen !== "object" || gen === null) return undefined
  const provider = (gen as Record<string, unknown>)["provider"]
  return typeof provider === "string" && provider !== "" ? provider : undefined
}

/** Default parallel-run width: config key `defaults.parallel.concurrency`.
 * Positive integer; 0 = unlimited. Falls back to 4 when unset or invalid. */
export function parallelConcurrency(config: CreatifactConfig): number {
  const defaults = config["defaults"]
  if (typeof defaults !== "object" || defaults === null) return 4
  const parallel = (defaults as Record<string, unknown>)["parallel"]
  if (typeof parallel !== "object" || parallel === null) return 4
  const value = (parallel as Record<string, unknown>)["concurrency"]
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return 4
  return value
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
  config: CreatifactConfig,
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
  config: CreatifactConfig,
): boolean {
  if (cliPlainHttp) return true
  return getRegistryEntry(config, registry)?.insecure === true
}

const RESERVED_KEYS = new Set(["version"])

export function getConfigValue(
  config: CreatifactConfig,
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

export function setConfigValue(config: CreatifactConfig, key: string, value: unknown): void {
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

/** True when a dotted config key (e.g. auths.localhost:5000.auth) targets a secret value. */
export function isSecretKey(dottedKey: string): boolean {
  const last = dottedKey.split(".").pop() ?? ""
  return SECRET_KEYS.has(last.toLowerCase())
}

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
