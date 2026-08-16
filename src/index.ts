#!/usr/bin/env node

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { BUILD_USAGE, runBuildFromArgs } from "./build"
import { CONFIG_USAGE, runConfigFromArgs } from "./configCmd"
import { GEN_USAGE, runGenFromArgs } from "./gen"
import { JOBS_USAGE, runJobsFromArgs } from "./jobs"
import { LOGIN_USAGE, LOGOUT_USAGE, runLoginFromArgs, runLogoutFromArgs } from "./login"
import { MODELS_USAGE, runModelsFromArgs } from "./models"
import { PULL_USAGE, runPullFromArgs } from "./pull"
import { PUSH_USAGE, runPushFromArgs } from "./push"

const MAIN_USAGE = `Usage: openmmcli <command> [options]

A lightweight CLI for building, pushing, and pulling OCI image layouts,
plus AI media generation via provider models.

Commands:
  build    Build an OCI image layout from a build manifest
  push     Push an OCI image layout to a registry
  pull     Pull an OCI image layout from a registry
  login    Save registry credentials to the config file
  logout   Remove saved registry credentials
  config   Manage the openmmcli config file
  gen      Generate media via a provider model (image/video/understand/embed)
  models   List providers and their verified models
  jobs     Resume polling a saved video task handle

Run \`openmmcli <command> --help\` for command details.

Global options:
  --config-dir <dir>    Use <dir>/config.json instead of ~/.openmmcli/config.json
                        (takes precedence over OPENMMCLI_CONFIG_DIR)`

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

const SUBCOMMANDS: SubcommandSpec[] = [
  { name: "build", usage: BUILD_USAGE, run: (args, o) => runBuildFromArgs(args, o) },
  { name: "push", usage: PUSH_USAGE, run: (args, o) => runPushFromArgs(args, o) },
  { name: "pull", usage: PULL_USAGE, run: (args, o) => runPullFromArgs(args, o) },
  { name: "login", usage: LOGIN_USAGE, run: (args, o) => runLoginFromArgs(args, o) },
  { name: "logout", usage: LOGOUT_USAGE, run: (args, o) => runLogoutFromArgs(args, o) },
  { name: "config", usage: CONFIG_USAGE, run: (args, o) => runConfigFromArgs(args, o) },
  { name: "gen", usage: GEN_USAGE, run: (args, o) => runGenFromArgs(args, o) },
  { name: "models", usage: MODELS_USAGE, run: (args, o) => runModelsFromArgs(args, o) },
  { name: "jobs", usage: JOBS_USAGE, run: (args, o) => runJobsFromArgs(args, o) },
]

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

const subcommand = process.argv[2]

if (
  subcommand === undefined ||
  subcommand === "help" ||
  subcommand === "--help" ||
  subcommand === "-h"
) {
  console.log(MAIN_USAGE)
  process.exit(0)
}

const spec = SUBCOMMANDS.find((cmd) => cmd.name === subcommand)

if (!spec) {
  console.error(`unknown command: ${subcommand}`)
  console.error(MAIN_USAGE)
  process.exit(1)
}

try {
  const { rest, configPath } = extractGlobalOptions(process.argv.slice(3))
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(spec.usage)
    process.exit(0)
  }
  await spec.run(rest, configPath === undefined ? {} : { configPath })
  process.exit(0)
} catch (e) {
  if (e instanceof Error) {
    console.error(`error: ${e.message}`)
    process.exit(1)
  }
  throw e
}
