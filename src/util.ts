import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"

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

export interface CliParseOptions {
  values?: Record<string, string>
  flags?: Record<string, string>
  repeats?: ReadonlySet<string>
}

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
}

/** "90s" / "5m" / "600"(裸数字=秒)→ ms;非法抛错。 */
export function parseDurationMs(raw: string, flag: string): number {
  const m = /^(\d+)(ms|s|m|h)?$/.exec(raw)
  if (!m || m[1] === undefined) {
    throw new Error(`invalid ${flag} '${raw}' (expected e.g. 90s, 5m, or bare seconds)`)
  }
  return Number(m[1]) * (DURATION_UNITS[m[2] ?? "s"] ?? 1000)
}

/** v 合法则 JSON.parse,否则原样字符串(与 `config set` 同语义)。 */
export function parseKvValue(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

export interface CliParseResult {
  values: Record<string, string | string[]>
  flags: Record<string, boolean>
  positionals: string[]
}

function consumeValue(
  values: Record<string, string | string[]>,
  key: string,
  value: string,
  repeatable: boolean,
): void {
  if (!repeatable) {
    values[key] = value
    return
  }
  const existing = values[key]
  values[key] = Array.isArray(existing) ? [...existing, value] : [value]
}

export function parseCliArgs(args: string[], opts: CliParseOptions): CliParseResult {
  const values: Record<string, string | string[]> = {}
  const flags: Record<string, boolean> = {}
  const positionals: string[] = []
  const valueKeys = opts.values ?? {}
  const flagKeys = opts.flags ?? {}
  const repeats = opts.repeats ?? new Set<string>()

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === undefined) {
      i++
      continue
    }

    const valueKey = valueKeys[arg]
    if (valueKey !== undefined) {
      const v = args[++i]
      if (v !== undefined) {
        consumeValue(values, valueKey, v, repeats.has(arg))
      }
      i++
      continue
    }

    const flagKey = flagKeys[arg]
    if (flagKey !== undefined) {
      flags[flagKey] = true
      i++
      continue
    }

    if (!arg.startsWith("-")) {
      positionals.push(arg)
    }
    i++
  }

  return { values, flags, positionals }
}
