#!/usr/bin/env node

import { readFileSync } from "node:fs"

import { Command } from "commander"

import { buildArgsFromOptions, buildBuildCommand, type BuildCommandOptions } from "./build"
import { buildConfigCommand } from "./configCmd"
import { executeCommand } from "./execute"
import { runFileFromArgs } from "./fileCmd"
import { buildGenerateCommand } from "./generate"
import { buildPackageCommand } from "./store"
import { buildAuthCommand } from "./login"
import { buildModelsCommand, type ModelsCommandOptions, modelsArgsFromOptions } from "./models"
import { buildPullCommand, type PullCommandOptions, pullArgsFromOptions } from "./pull"
import { buildPushCommand, type PushCommandOptions, pushArgsFromOptions } from "./push"
import { addGlobalOptions, configOpts } from "./util"

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string
}

const program = new Command()
  .name("openmmcli")
  .description(`A lightweight CLI for building, pushing, and pulling OCI image layouts,
plus AI media generation via provider models.

  openmmcli -f <file>.json [options]     Run a command described by a JSON file
  openmmcli <command> [args]`)
  .version(pkg.version)
  .enablePositionalOptions()
  .allowExcessArguments(true)

addGlobalOptions(program)

// --- -f <file>.json: run the command described by a JSON file ---
program
  .command("-f <file> [args...]")
  .usage("<file>.json [options] [-- generate flags]")
  .description(
    "Run a command (or a steps pipeline) described by a JSON file. Pipeline files use {steps:[{name?, command, ...fields}]} and run sequentially with ${step.field} references to earlier results",
  )
  .allowExcessArguments(true)
  .passThroughOptions(true)
  .action(async (file: string, args: string[], _opts, command: Command) => {
    const { rest, configDir } = extractConfigDir(args)
    await runFileFromArgs([file, ...rest], configOpts(command, configDir))
  })

// --- build | push | pull: OCI package lifecycle (top-level, docker-style) ---
program.addCommand(
  buildBuildCommand().action(async (options: BuildCommandOptions, command: Command) => {
    await executeCommand(
      { kind: "build", req: buildArgsFromOptions(options) },
      configOpts(command, options.configDir),
    )
  }),
)
program.addCommand(
  buildPushCommand().action(
    async (ref: string | undefined, options: PushCommandOptions, command: Command) => {
      await executeCommand(
        { kind: "push", req: pushArgsFromOptions(ref, options) },
        configOpts(command, options.configDir),
      )
    },
  ),
)
program.addCommand(
  buildPullCommand().action(
    async (ref: string | undefined, options: PullCommandOptions, command: Command) => {
      await executeCommand(
        { kind: "pull", req: pullArgsFromOptions(ref, options) },
        configOpts(command, options.configDir),
      )
    },
  ),
)

// --- auth: login | logout ---
program.addCommand(buildAuthCommand())

// --- config: path | list | get | set | reset ---
program.addCommand(buildConfigCommand())

// --- models ---
program.addCommand(
  buildModelsCommand().action(
    async (provider: string | undefined, options: ModelsCommandOptions, command: Command) => {
      await executeCommand(
        { kind: "models", req: modelsArgsFromOptions(provider, options) },
        configOpts(command, options.configDir),
      )
    },
  ),
)

// --- generate / gen ---
program.addCommand(buildGenerateCommand().alias("gen"))

// --- package: store management (list / ls, rm) ---
program.addCommand(buildPackageCommand())

// --- bare invocation / unknown top-level command ---
program.action((_options, command) => {
  const unknown = command.args[0]
  if (unknown === undefined) {
    command.help()
    return
  }
  console.error(`unknown command: ${unknown}`)
  command.outputHelp({ error: true })
  process.exit(1)
})

/** Strip a --config-dir <dir> from -f passthrough args (they bypass commander options). */
function extractConfigDir(args: string[]): { rest: string[]; configDir?: string } {
  const rest: string[] = []
  let configDir: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) continue
    if (arg === "--config-dir") {
      const dir = args[i + 1]
      if (dir === undefined || dir === "") {
        throw new Error("--config-dir requires a directory")
      }
      i++
      configDir = dir
      continue
    }
    rest.push(arg)
  }
  return configDir === undefined ? { rest } : { rest, configDir }
}

program.parseAsync(process.argv).then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  },
)
