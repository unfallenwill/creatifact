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
