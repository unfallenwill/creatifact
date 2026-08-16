import { capabilitiesOf, createProvider, listConfiguredProviderIds } from "./providers"
import { parseCliArgs } from "./util"

export const MODELS_USAGE = `Usage: openmmcli models [provider] [options]

List providers and their verified models.

Without arguments, one line per available provider (built-ins plus any
provider configured with providers.<id>.module). Providers whose credentials
are missing or whose plugin fails to load are noted on stderr and skipped.

With a provider argument, lists its models with capability tags and notes.

Options:
      --json            Full metadata as JSON
  -h, --help            Show this help message`

const VALUE_OPTS: Record<string, string> = {}
const BOOL_FLAGS: Record<string, string> = { "--json": "json" }

export function parseModelsArgs(args: string[]): { provider: string | undefined; json: boolean } {
  const parsed = parseCliArgs(args, { values: VALUE_OPTS, flags: BOOL_FLAGS })
  return {
    provider: parsed.positionals[0],
    json: parsed.flags["json"] === true,
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

export async function runModelsFromArgs(
  args: string[],
  opts: { configPath?: string } = {},
): Promise<void> {
  const { provider: id, json } = parseModelsArgs(args)

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
    console.log(`${m.id}  ${caps}${m.note ? `  ${truncate(m.note, 60)}` : ""}`)
  }
}
