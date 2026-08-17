#!/usr/bin/env node

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { BUILD_USAGE, runBuildFromArgs } from "./build"
import { CONFIG_USAGE, runConfigFromArgs } from "./configCmd"
import { FILE_USAGE, runFileFromArgs } from "./fileCmd"
import { runGenerateFromArgs } from "./generate"
import { LOGIN_USAGE, LOGOUT_USAGE, runLoginFromArgs, runLogoutFromArgs } from "./login"
import { MODELS_USAGE, runModelsFromArgs } from "./models"
import { PULL_USAGE, runPullFromArgs } from "./pull"
import { PUSH_USAGE, runPushFromArgs } from "./push"

const MAIN_USAGE = `Usage:
  openmmcli -f <file>.json [options]     Run a command described by a JSON file
  openmmcli <command> [args]

A lightweight CLI for building, pushing, and pulling OCI image layouts,
plus AI media generation via provider models.

Commands:
  generate  Generate media by task (gen is an alias)
            (generate text2image|image2image|text2video|... | generate <ref>)
  package   Build, push, and pull OCI image layouts
            (package build|push|pull)
  auth      Save or remove registry credentials (auth login|logout)
  config    Manage the openmmcli config file
  models    List providers and their verified models

Run \`openmmcli <command> --help\` for command details.

Global options:
  --config-dir <dir>    Use <dir>/config.json instead of ~/.openmmcli/config.json
                        (takes precedence over OPENMMCLI_CONFIG_DIR)`

const PACKAGE_USAGE = `Usage: openmmcli package <action> [args]

Build, push, and pull OCI image layouts.

Actions:
  build    Build an OCI image layout from a build manifest
  push     Push an OCI image layout to a registry
  pull     Pull an OCI image layout from a registry

Run \`openmmcli package <action> --help\` for action details.`

const AUTH_USAGE = `Usage: openmmcli auth <action> [args]

Manage registry credentials stored in the openmmcli config file.

Actions:
  login    Save registry credentials to the config file
  logout   Remove saved registry credentials

Run \`openmmcli auth <action> --help\` for action details.`

if (process.argv.includes("--version")) {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string
  }
  console.log(pkg.version)
  process.exit(0)
}

interface GlobalRunOptions {
  configPath?: string
}

interface SubcommandSpec {
  name: string
  usage: string
  run: (args: string[], opts: GlobalRunOptions) => Promise<void>
}

const PACKAGE_ACTIONS: Record<string, { usage: string; run: SubcommandSpec["run"] }> = {
  build: { usage: BUILD_USAGE, run: (a, o) => runBuildFromArgs(a, o) },
  push: { usage: PUSH_USAGE, run: (a, o) => runPushFromArgs(a, o) },
  pull: { usage: PULL_USAGE, run: (a, o) => runPullFromArgs(a, o) },
}

const AUTH_ACTIONS: Record<string, { usage: string; run: SubcommandSpec["run"] }> = {
  login: { usage: LOGIN_USAGE, run: (a, o) => runLoginFromArgs(a, o) },
  logout: { usage: LOGOUT_USAGE, run: (a, o) => runLogoutFromArgs(a, o) },
}

const TOP_LEVEL: Record<string, SubcommandSpec> = {
  config: { name: "config", usage: CONFIG_USAGE, run: (a, o) => runConfigFromArgs(a, o) },
  models: { name: "models", usage: MODELS_USAGE, run: (a, o) => runModelsFromArgs(a, o) },
}

/** Strip the global `--config-dir <dir>` flag; returns remaining args and the resolved config file path. */
function extractGlobalOptions(args: string[]): { rest: string[]; configPath?: string } {
  const rest: string[] = []
  let configPath: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) continue
    if (arg === "--config-dir") {
      const dir = args[i + 1]
      if (dir === undefined || dir === "") {
        throw new Error("--config-dir requires a directory")
      }
      i++
      configPath = join(dir, "config.json")
      continue
    }
    rest.push(arg)
  }
  return configPath === undefined ? { rest } : { rest, configPath }
}

/** Run a grouped command (package/auth): dispatch on the action, honoring --help. */
async function runGrouped(
  group: string,
  actions: typeof PACKAGE_ACTIONS,
  groupUsage: string,
  args: string[],
  opts: GlobalRunOptions,
): Promise<void> {
  const action = args[0]
  if (action === undefined || action === "--help" || action === "-h") {
    console.log(groupUsage)
    return
  }
  const spec = actions[action]
  if (spec === undefined) {
    throw new Error(
      `unknown ${group} action '${action}' (expected ${Object.keys(actions).join(", ")})`,
    )
  }
  const rest = args.slice(1)
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(spec.usage)
    return
  }
  await spec.run(rest, opts)
}

const head = process.argv[2]

if (head === undefined || head === "help" || head === "--help" || head === "-h") {
  console.log(MAIN_USAGE)
  process.exit(0)
}

try {
  const { rest, configPath } = extractGlobalOptions(process.argv.slice(3))
  const opts: GlobalRunOptions = configPath === undefined ? {} : { configPath }

  if (head === "-f") {
    if (rest.includes("--help") || rest.includes("-h")) {
      console.log(FILE_USAGE)
      process.exit(0)
    }
    await runFileFromArgs(rest, opts)
    process.exit(0)
  }

  if (head === "generate" || head === "gen") {
    await runGenerateFromArgs(rest, opts)
    process.exit(0)
  }

  if (head === "package") {
    await runGrouped("package", PACKAGE_ACTIONS, PACKAGE_USAGE, rest, opts)
    process.exit(0)
  }

  if (head === "auth") {
    await runGrouped("auth", AUTH_ACTIONS, AUTH_USAGE, rest, opts)
    process.exit(0)
  }

  const spec = TOP_LEVEL[head]
  if (spec === undefined) {
    console.error(`unknown command: ${head}`)
    console.error(MAIN_USAGE)
    process.exit(1)
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(spec.usage)
    process.exit(0)
  }
  await spec.run(rest, opts)
  process.exit(0)
} catch (e) {
  if (e instanceof Error) {
    console.error(`error: ${e.message}`)
    process.exit(1)
  }
  throw e
}
