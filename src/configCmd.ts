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
import { usageError } from "./errors"
import { emitResult } from "./output"
import { addGlobalOptions, configOpts, prettyOpts } from "./util"

/** The data payload of a `config` command (envelope data, minus `kind`). */
export type ConfigActionResult =
  | { action: "path"; path: string }
  | { action: "list"; config: Record<string, unknown> }
  | { action: "get"; key: string; value: unknown; secret?: boolean }
  | { action: "set"; key: string; value: unknown }
  | { action: "reset"; path: string; removed: boolean }

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
): ConfigActionResult {
  const file = opts.configPath ?? configPath()

  switch (action) {
    case "path":
      expectNoArgs(rest, "config path")
      return { action: "path", path: file }

    case "list": {
      expectNoArgs(rest, "config list")
      return { action: "list", config: maskForPrint(loadConfig(file)) as Record<string, unknown> }
    }

    case "get": {
      const key = requireKey(rest, "config get")
      const { found, value } = getConfigValue(loadConfig(file), key)
      if (!found) {
        throw usageError(`config key not found: ${key}`)
      }
      if (isSecretKey(key)) {
        return { action: "get", key, value: "***", secret: true }
      }
      return { action: "get", key, value }
    }

    case "set": {
      const key = requireKey(rest.slice(0, 1), "config set")
      const rawValue = requireKey(rest.slice(1), "config set")
      const value = parseValue(rawValue)
      const config = loadConfig(file)
      setConfigValue(config, key, value)
      saveConfig(config, file)
      return { action: "set", key, value }
    }

    case "reset": {
      expectNoArgs(rest, "config reset")
      const removed = deleteConfig(file)
      return { action: "reset", path: file, removed }
    }

    default:
      throw usageError(
        action === ""
          ? "config requires an action: path, list, get, set, reset"
          : `unknown config action: ${action}`,
      )
  }
}

export async function runConfigFromArgs(
  args: string[],
  opts: { configPath?: string } = {},
): Promise<ConfigActionResult> {
  const { action, rest } = parseConfigArgs(args)
  return runConfigAction(action ?? "", rest, opts)
}

/** Run one config action and emit its result envelope. */
function emitConfigAction(
  action: string,
  rest: string[],
  command: Command,
  configDir?: string,
): void {
  const result = runConfigAction(action, rest, configOpts(command, configDir))
  emitResult("config", result, prettyOpts(command))
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
    .action((options, command) => emitConfigAction("path", [], command, options.configDir))
  config
    .command("list")
    .description("Print the config with secret values masked")
    .action((options, command) => emitConfigAction("list", [], command, options.configDir))
  config
    .command("get")
    .description("Print a value (dotted key, e.g. auths.localhost:5000.username)")
    .argument("[key]")
    .action((key: string | undefined, options, command) =>
      emitConfigAction("get", key === undefined ? [] : [key], command, options.configDir),
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
      emitConfigAction("set", rest, command, options.configDir)
    })
  config
    .command("reset")
    .description("Delete the config file")
    .action((options, command) => emitConfigAction("reset", [], command, options.configDir))

  config.action((_opts, command) => {
    const action = command.args[0]
    if (action === undefined) {
      command.help()
      return
    }
    throw usageError(`unknown config action: ${action}`)
  })
  return config
}

function expectNoArgs(rest: string[], action: string): void {
  if (rest.length > 0) {
    throw usageError(`${action} takes no arguments`)
  }
}

function requireKey(parts: string[], action: string): string {
  const value = parts[0]
  if (value === undefined) {
    throw usageError(`${action} requires a key argument`)
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
