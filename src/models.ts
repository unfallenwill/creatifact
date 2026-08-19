import { Command } from "commander"
import { loadConfig } from "./config"
import { CliError } from "./errors"
import { warn } from "./format"
import { listConfiguredProviderIds, listProviderCatalog, type VerifiedModel } from "./providers"
import { tasksForModel } from "./tasks"
import { addGlobalOptions, parseArgsWith } from "./util"

export interface ModelsCommandOptions {
  configDir?: string
}

export function buildModelsCommand(): Command {
  const cmd = new Command("models")
    .description("List providers and their verified models as JSON")
    .argument("[provider]")
  return addGlobalOptions(cmd)
}

export function modelsArgsFromOptions(
  provider: string | undefined,
  _o: ModelsCommandOptions,
): { provider: string | undefined } {
  return { provider }
}

export function parseModelsArgs(args: string[]): { provider: string | undefined } {
  const { options, positionals } = parseArgsWith<ModelsCommandOptions>(buildModelsCommand(), args)
  return modelsArgsFromOptions(positionals[0], options)
}

export interface CatalogModel extends VerifiedModel {
  tasks: string[]
}

/** One provider's catalog entry; `error` marks an unavailable provider. */
export interface ProviderCatalogEntry {
  provider: string
  defaults?: Record<string, string> | undefined
  models?: CatalogModel[] | undefined
  error?: string | undefined
}

/** The `models` command payload: one provider, or every configured one. */
export type ModelsResult =
  | { provider: string; defaults: Record<string, string>; models: CatalogModel[] }
  | { providers: ProviderCatalogEntry[] }

export async function runModelsFromParsed(
  parsed: { provider: string | undefined },
  opts: { configPath?: string } = {},
): Promise<ModelsResult> {
  const id = parsed.provider

  // models.<providerId> keys must name known providers; reject loudly so a
  // typo never silently shadows a whole declaration list.
  const config = loadConfig(opts.configPath)
  const declared = Object.keys(config.models ?? {})
  const known = new Set(listConfiguredProviderIds(opts))
  const unknown = declared.filter((key) => !known.has(key))
  if (unknown.length > 0) {
    throw new CliError(
      "E_CONFIG",
      `models config: unknown provider '${unknown.join("', '")}' (available: ${[...known].join(
        ", ",
      )}); remove the key or declare the provider first`,
    )
  }

  if (id === undefined) {
    const providers: ProviderCatalogEntry[] = []
    for (const providerId of listConfiguredProviderIds(opts)) {
      try {
        const { provider } = await listProviderCatalog(providerId, opts)
        providers.push({
          provider: providerId,
          defaults: provider.defaultModels,
          models: provider.models.map((m) => ({ ...m, tasks: tasksForModel(m) })),
        })
      } catch (e) {
        const message = (e as Error).message
        // Unavailable providers stay in the payload (marked) instead of
        // silently vanishing from the listing; stderr keeps a human note.
        providers.push({ provider: providerId, error: message })
        warn(`${providerId}: unavailable (${message})`)
      }
    }
    return { providers }
  }

  const { provider } = await listProviderCatalog(id, opts)
  return {
    provider: id,
    defaults: provider.defaultModels ?? {},
    models: provider.models.map((m) => ({ ...m, tasks: tasksForModel(m) })),
  }
}

export async function runModelsFromArgs(
  args: string[],
  opts: { configPath?: string } = {},
): Promise<ModelsResult> {
  return runModelsFromParsed(parseModelsArgs(args), opts)
}
