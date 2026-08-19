import { Command } from "commander"

import { loadConfig } from "./config"
import { capabilitiesOf, createProvider, listConfiguredProviderIds } from "./providers"
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
    for (const providerId of listConfiguredProviderIds(opts)) {
      try {
        const provider = await createProvider(providerId, opts)
        console.log(
          `${providerId}  (${capabilitiesOf(provider).join(", ")}, ${provider.models.length} models)`,
        )
      } catch (e) {
        console.error(`${providerId}: unavailable (${(e as Error).message})`)
      }
    }
    return
  }

  const provider = await createProvider(id, opts)
  if (json) {
    console.log(JSON.stringify({ provider: id, models: provider.models }, null, 2))
    return
  }
  for (const m of provider.models) {
    const caps = Object.keys(m.capabilities).join(", ")
    const custom = m.source === "custom" ? " (custom)" : ""
    console.log(`${m.id}${custom}  ${caps}${m.note ? `  ${truncate(m.note, 60)}` : ""}`)
  }
}

export async function runModelsFromArgs(
  args: string[],
  opts: { configPath?: string } = {},
): Promise<void> {
  await runModelsFromParsed(parseModelsArgs(args), opts)
}
