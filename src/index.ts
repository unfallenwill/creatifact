#!/usr/bin/env node

import { readFileSync } from "node:fs"

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

Run \`openmmcli <command> --help\` for command details.`

if (process.argv.includes("--version")) {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string
  }
  console.log(pkg.version)
  process.exit(0)
}

interface SubcommandSpec {
  name: string
  usage: string
  run: (args: string[]) => Promise<void>
}

const SUBCOMMANDS: SubcommandSpec[] = [
  { name: "build", usage: BUILD_USAGE, run: (args) => runBuildFromArgs(args) },
  { name: "push", usage: PUSH_USAGE, run: (args) => runPushFromArgs(args) },
  { name: "pull", usage: PULL_USAGE, run: (args) => runPullFromArgs(args) },
  { name: "login", usage: LOGIN_USAGE, run: (args) => runLoginFromArgs(args) },
  { name: "logout", usage: LOGOUT_USAGE, run: (args) => runLogoutFromArgs(args) },
  { name: "config", usage: CONFIG_USAGE, run: (args) => runConfigFromArgs(args) },
  { name: "gen", usage: GEN_USAGE, run: (args) => runGenFromArgs(args) },
  { name: "models", usage: MODELS_USAGE, run: (args) => runModelsFromArgs(args) },
  { name: "jobs", usage: JOBS_USAGE, run: (args) => runJobsFromArgs(args) },
]

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

const rest = process.argv.slice(3)
if (rest.includes("--help") || rest.includes("-h")) {
  console.log(spec.usage)
  process.exit(0)
}

try {
  await spec.run(rest)
  process.exit(0)
} catch (e) {
  console.error(`error: ${(e as Error).message}`)
  process.exit(1)
}
