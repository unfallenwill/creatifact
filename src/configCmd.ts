import { Command } from "commander"

import {
  configPath,
  deleteConfig,
  getConfigValue,
  isSecretKey,
  loadConfig,
  maskForPrint,
  saveConfig,
  setConfigValue,
} from "./config"
import { addGlobalOptions, configOpts } from "./util"

export function parseConfigArgs(args: string[]): {
  action: string | undefined
  rest: string[]
} {
  return { action: args[0], rest: args.slice(1) }
}

export function runConfigAction(
  action: string,
  rest: string[],
  opts: { configPath?: string } = {},
): void {
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
      if (isSecretKey(key)) {
        console.log("***")
        return
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
        action === ""
          ? "config requires an action: path, list, get, set, reset"
          : `unknown config action: ${action}`,
      )
  }
}

export async function runConfigFromArgs(
  args: string[],
  opts: { configPath?: string } = {},
): Promise<void> {
  const { action, rest } = parseConfigArgs(args)
  runConfigAction(action ?? "", rest, opts)
}

export function buildConfigCommand(): Command {
  const config = new Command("config")
    .usage("<action>")
    .description(
      "Manage the creatifact config file (~/.creatifact/config.json by default, overridable via CREATIFACT_CONFIG_DIR)",
    )
  addGlobalOptions(config)
  config.allowExcessArguments(true)

  config
    .command("path")
    .description("Print the config file path")
    .action((options, command) =>
      runConfigAction("path", [], configOpts(command, options.configDir)),
    )
  config
    .command("list")
    .description("Print the config with secret values masked")
    .action((options, command) =>
      runConfigAction("list", [], configOpts(command, options.configDir)),
    )
  config
    .command("get")
    .description("Print a value (dotted key, e.g. auths.localhost:5000.username)")
    .argument("[key]")
    .action((key: string | undefined, options, command) =>
      runConfigAction(
        "get",
        key === undefined ? [] : [key],
        configOpts(command, options.configDir),
      ),
    )
  config
    .command("set")
    .description(
      "Set a value (value parsed as JSON if valid, else string; credentials belong to `creatifact auth login`, not `config set`)",
    )
    .argument("[key]")
    .argument("[value]")
    .action((key: string | undefined, value: string | undefined, options, command) => {
      const rest = [key, value].filter((v): v is string => v !== undefined)
      runConfigAction("set", rest, configOpts(command, options.configDir))
    })
  config
    .command("reset")
    .description("Delete the config file")
    .action((options, command) =>
      runConfigAction("reset", [], configOpts(command, options.configDir)),
    )

  config.action((_opts, command) => {
    const action = command.args[0]
    if (action === undefined) {
      command.help()
      return
    }
    throw new Error(`unknown config action: ${action}`)
  })
  return config
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
