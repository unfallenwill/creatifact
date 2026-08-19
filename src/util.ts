import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { join } from "node:path"

import { type Command, CommanderError } from "commander"

import { pc } from "./format"

export async function ensureOutputDirEmpty(outputDir: string): Promise<void> {
  if (existsSync(outputDir)) {
    const entries = await readdir(outputDir)
    if (entries.length > 0) {
      throw new Error(`--output '${outputDir}' already exists and is not empty`)
    }
  }
}

export function readPasswordFromStdin(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    process.stdin.on("data", (chunk) => chunks.push(chunk))
    process.stdin.on("end", () =>
      resolve(Buffer.concat(chunks).toString("utf8").trim() || undefined),
    )
    process.stdin.on("error", () => resolve(undefined))
  })
}

export async function resolvePassword(
  password: string | undefined,
  useStdin: boolean,
): Promise<string | undefined> {
  if (useStdin) return readPasswordFromStdin()
  return password
}

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
}

/** "90s" / "5m" / "600" (bare number = seconds) → ms; throws on invalid input. */
export function parseDurationMs(raw: string, flag: string): number {
  const m = /^(\d+)(ms|s|m|h)?$/.exec(raw)
  if (!m || m[1] === undefined) {
    throw new Error(`invalid ${flag} '${raw}' (expected e.g. 90s, 5m, or bare seconds)`)
  }
  return Number(m[1]) * (DURATION_UNITS[m[2] ?? "s"] ?? 1000)
}

/** JSON.parse when valid, else the literal string (same semantics as `config set`). */
export function parseKvValue(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

export function collectValue(value: string, previous: string[] = []): string[] {
  return [...previous, value]
}

/**
 * Parse raw CLI args with a commander Command. Used by the parse* helpers and
 * by unit tests; commander's own parse errors (unknown option, missing
 * argument, ...) are converted to plain Errors so callers format them
 * uniformly. The command must not have an action attached.
 */
export function parseArgsWith<T extends object = Record<string, unknown>>(
  cmd: Command,
  args: string[],
): { options: T; positionals: string[] } {
  try {
    cmd.exitOverride()
    cmd.parse(args, { from: "user" })
  } catch (e) {
    if (e instanceof CommanderError) throw new Error(e.message)
    throw e
  }
  return { options: cmd.opts() as T, positionals: cmd.args }
}

/**
 * Wire commander's help formatter into the CLI's TTY-gated color instance:
 * section titles bold, argument/option/subcommand terms cyan, descriptions
 * plain. Piped output stays byte-identical plain text — help is the first
 * thing agents read, so the same color contract as every other surface
 * applies here too.
 */
function styleHelp(cmd: Command): Command {
  return cmd.configureHelp({
    styleTitle: (t) => pc.bold(t),
    styleUsage: (t) => pc.bold(t),
    styleCommandText: (t) => pc.bold(t),
    styleArgumentTerm: (t) => pc.cyan(t),
    styleOptionTerm: (t) => pc.cyan(t),
    styleSubcommandTerm: (t) => pc.cyan(t),
  })
}

export function addGlobalOptions(cmd: Command): Command {
  styleHelp(cmd)
  return cmd.option(
    "--config-dir <dir>",
    "Use <dir>/config.json instead of ~/.creatifact/config.json (takes precedence over CREATIFACT_CONFIG_DIR)",
  )
}

/**
 * The {configPath?} bag for run functions: first non-undefined candidate dir
 * wins, else the --config-dir captured by an ancestor command (the program).
 */
export function configOpts(
  command: Command,
  ...candidates: (string | undefined)[]
): { configPath?: string } {
  const dir = candidates.find((d) => d !== undefined) ?? parentConfigDir(command)
  return dir === undefined ? {} : { configPath: join(dir, "config.json") }
}

function parentConfigDir(command: Command): string | undefined {
  for (let cmd: Command | null = command.parent; cmd !== null; cmd = cmd.parent) {
    const dir = cmd.getOptionValue("configDir")
    if (typeof dir === "string") return dir
  }
  return undefined
}
