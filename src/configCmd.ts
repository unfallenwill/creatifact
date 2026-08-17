import {
  configPath,
  deleteConfig,
  getConfigValue,
  loadConfig,
  maskForPrint,
  saveConfig,
  setConfigValue,
} from "./config"
import { parseCliArgs } from "./util"

export const CONFIG_USAGE = `Usage: openmmcli config <action> [args]

Manage the openmmcli config file (~/.openmmcli/config.json by default,
overridable via OPENMMCLI_CONFIG_DIR).

Actions:
  path                  Print the config file path
  list                  Print the config with secret values masked
  get <key>             Print a value (dotted key, e.g. auths.localhost:5000.username)
  set <key> <value>     Set a value (value parsed as JSON if valid, else string;
                        credentials belong to \`openmmcli auth login\`, not \`config set\`)
  reset                 Delete the config file
  -h, --help            Show this help message`

export function parseConfigArgs(args: string[]): {
  action: string | undefined
  rest: string[]
} {
  const parsed = parseCliArgs(args, {})
  return { action: parsed.positionals[0], rest: parsed.positionals.slice(1) }
}

export async function runConfigFromArgs(
  args: string[],
  opts: { configPath?: string } = {},
): Promise<void> {
  const { action, rest } = parseConfigArgs(args)
  const file = opts.configPath ?? configPath()

  switch (action) {
    case "path":
      expectNoArgs(rest, "config path")
      console.log(file)
      return

    case "list":
      expectNoArgs(rest, "config list")
      console.log(JSON.stringify(maskForPrint(loadConfig(file)), null, 2))
      return

    case "get": {
      const key = requireKey(rest, "config get")
      const { found, value } = getConfigValue(loadConfig(file), key)
      if (!found) {
        throw new Error(`config key not found: ${key}`)
      }
      console.log(typeof value === "string" ? value : JSON.stringify(value))
      return
    }

    case "set": {
      const key = requireKey(rest.slice(0, 1), "config set")
      const rawValue = requireKey(rest.slice(1), "config set")
      const config = loadConfig(file)
      setConfigValue(config, key, parseValue(rawValue))
      saveConfig(config, file)
      console.log(`Set ${key}`)
      return
    }

    case "reset":
      expectNoArgs(rest, "config reset")
      if (deleteConfig(file)) {
        console.log(`Removed ${file}`)
      } else {
        console.log(`No config file at ${file}`)
      }
      return

    default:
      throw new Error(
        action === undefined
          ? "config requires an action: path, list, get, set, reset"
          : `unknown config action: ${action}`,
      )
  }
}

function expectNoArgs(rest: string[], action: string): void {
  if (rest.length > 0) {
    throw new Error(`${action} takes no arguments`)
  }
}

function requireKey(parts: string[], action: string): string {
  const value = parts[0]
  if (value === undefined) {
    throw new Error(`${action} requires a key argument`)
  }
  return value
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}
