import { Command } from "commander"

import { loadConfig } from "./config"
import { displayWidth, pc } from "./format"
import { listConfiguredProviderIds, listProviderCatalog, type VerifiedModel } from "./providers"
import { tasksForModel } from "./tasks"
import { addGlobalOptions, parseArgsWith } from "./util"

export interface ModelsCommandOptions {
  json?: boolean
  configDir?: string
}

export function buildModelsCommand(): Command {
  const cmd = new Command("models")
    .description("List providers and their verified models")
    .argument("[provider]")
    .option("--json", "Full metadata as JSON")
  return addGlobalOptions(cmd)
}

export function modelsArgsFromOptions(
  provider: string | undefined,
  o: ModelsCommandOptions,
): { provider: string | undefined; json: boolean } {
  return { provider, json: o.json === true }
}

export function parseModelsArgs(args: string[]): { provider: string | undefined; json: boolean } {
  const { options, positionals } = parseArgsWith<ModelsCommandOptions>(buildModelsCommand(), args)
  return modelsArgsFromOptions(positionals[0], options)
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

interface CatalogRow {
  providerId: string
  model: VerifiedModel
  isDefault: boolean
}

/**
 * The flat catalog listing: one row per model as <provider>/<model-id> (the
 * exact reference syntax the CLI accepts) with aligned columns and no
 * section markers — a pure data table. Notes clamp to the terminal width so
 * lines never wrap mid-column; piped output falls back to a conservative
 * width and stays plain text for agents.
 */

/** Build the raw (uncolored) catalog table with per-provider comment rows. */
/** Build the flat catalog table: one row per model, no section markers. */
function buildCatalogTable(rows: CatalogRow[], noteBudget: number): string[][] {
  return rows.map((r) => {
    const custom = r.model.source === "custom" ? " (custom)" : ""
    return [
      // default rows turn green on TTY; plain piped output has no marker
      // (`--list-models` names the default explicitly instead)
      `${r.providerId}/${r.model.id}${custom}`,
      tasksForModel(r.model).join(", ") || "(—)",
      r.model.note ? truncate(r.model.note, noteBudget) : "",
    ]
  })
}

/** Color one data row per column and pad to the shared column widths. */
function colorRow(cells: string[], widths: number[], isDefault = false): string {
  const last = cells.length - 1
  return cells
    .map((cell, col) => {
      const pad = " ".repeat((widths[col] ?? 0) - displayWidth(cell))
      const base = isDefault ? pc.green(cell) : cell
      const colored = col === 0 ? pc.bold(base) : col === 1 ? pc.cyan(base) : pc.dim(base)
      return col === last ? colored : colored + pad
    })
    .join("  ")
}

function printCatalog(rows: CatalogRow[]): void {
  const termWidth = process.stdout.columns ?? 100
  const noteBudget = Math.max(20, termWidth - 58)
  const table = buildCatalogTable(rows, noteBudget)
  const widths = columnWidths(table)
  const defaults = new Set(
    rows.filter((r) => r.isDefault).map((r) => `${r.providerId}/${r.model.id}`),
  )
  for (const row of table) {
    const isDefault = defaults.has(row[0] ?? "")
    console.log(`  ${colorRow(row, widths, isDefault)}`)
  }
}

/** Column widths of the aligned table (mirrors alignColumns). */
function columnWidths(rows: string[][]): number[] {
  const width = Math.max(...rows.map((r) => r.length))
  return Array.from({ length: width }, (_, col) =>
    Math.max(...rows.map((r) => displayWidth(r[col] ?? ""))),
  )
}

export async function runModelsFromParsed(
  parsed: { provider: string | undefined; json: boolean },
  opts: { configPath?: string } = {},
): Promise<void> {
  const { provider: id, json } = parsed

  // models.<providerId> keys must name known providers; reject loudly so a
  // typo never silently shadows a whole declaration list.
  const config = loadConfig(opts.configPath)
  const declared = Object.keys(config.models ?? {})
  const known = new Set(listConfiguredProviderIds(opts))
  const unknown = declared.filter((key) => !known.has(key))
  if (unknown.length > 0) {
    throw new Error(
      `models config: unknown provider '${unknown.join("', '")}' (available: ${[...known].join(
        ", ",
      )}); remove the key or declare the provider first`,
    )
  }

  if (id === undefined) {
    const rows: CatalogRow[] = []
    for (const providerId of listConfiguredProviderIds(opts)) {
      try {
        const { provider } = await listProviderCatalog(providerId, opts)
        const defaults = new Set(Object.values(provider.defaultModels ?? {}))
        for (const m of provider.models) {
          rows.push({
            providerId,
            model: m,
            isDefault: defaults.has(m.id),
          })
        }
      } catch (e) {
        console.error(`${providerId}: unavailable (${(e as Error).message})`)
      }
    }
    printCatalog(rows)
    return
  }

  const { provider } = await listProviderCatalog(id, opts)
  const defaults = new Set(Object.values(provider.defaultModels ?? {}))
  if (json) {
    console.log(
      JSON.stringify(
        {
          provider: id,
          defaults: provider.defaultModels,
          models: provider.models.map((m) => ({ ...m, tasks: tasksForModel(m) })),
        },
        null,
        2,
      ),
    )
    return
  }
  printCatalog(
    provider.models.map((m) => ({
      providerId: id,
      model: m,
      isDefault: defaults.has(m.id),
    })),
  )
}

export async function runModelsFromArgs(
  args: string[],
  opts: { configPath?: string } = {},
): Promise<void> {
  await runModelsFromParsed(parseModelsArgs(args), opts)
}
