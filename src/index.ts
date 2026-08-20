#!/usr/bin/env node

import { readFileSync } from "node:fs"

import { Command, CommanderError } from "commander"

import { type BuildCommandOptions, buildArgsFromOptions, buildBuildCommand } from "./build"
import { buildConfigCommand } from "./configCmd"
import { usageError } from "./errors"
import { executeCommand, resultData } from "./execute"
import { type FileRunResult, runFileFromArgs } from "./fileCmd"
import { buildGenerateCommand } from "./generate"
import { armInterrupts } from "./interrupt"
import { buildAuthCommand } from "./login"
import { buildModelsCommand, type ModelsCommandOptions, modelsArgsFromOptions } from "./models"
import { emitError, emitResult } from "./output"
import { buildPullCommand, type PullCommandOptions, pullArgsFromOptions } from "./pull"
import { buildPushCommand, type PushCommandOptions, pushArgsFromOptions } from "./push"
import { buildPackageCommand, buildTagCommand } from "./store"
import { addGlobalOptions, configOpts, prettyOpts } from "./util"

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string
}

// One interrupt signal for the whole process: every in-flight request,
// poll, and pipeline step composes it with its own deadlines. Second
// Ctrl-C falls through to the shell's default kill.
armInterrupts()

const program = new Command()
  .name("creatifact")
  .description(`An agent-native multimodal creation executor with OCI artifact capabilities.

  creatifact -f <file>.json [options]     Run a command described by a JSON file
  creatifact <command> [args]`)
  .version(pkg.version)
  .enablePositionalOptions()
  .allowExcessArguments(true)

// Route every failure through the JSON error envelope: commander's own
// stderr text is captured (not written) so stderr carries exactly one JSON
// document, and exits are intercepted so the process status comes from the
// error code mapping. Help/version text still goes to stdout untouched.
program.exitOverride()
program.configureOutput({
  writeErr: () => {},
})

addGlobalOptions(program)

// --- -f <file>.json: run the command described by a JSON file ---
program
  .command("-f <file> [args...]")
  .usage("<file>.json [options] [-- generate flags]")
  .description(
    `Run the single command described by a JSON file — the exact mirror of one command line, for when flags get unwieldy. Example: {"command":"generate.text2image","prompt":"a crane"} equals \`creatifact generate text2image --prompt "a crane"\`; flags after the file override generate fields. Multi-step orchestration lives in creatifact-build.json (stages)`,
  )
  .allowExcessArguments(true)
  .passThroughOptions(true)
  .action(async (file: string, args: string[], _opts, command: Command) => {
    const { rest, configDir, pretty } = extractPassthroughFlags(args)
    const result = await runFileFromArgs([file, ...rest], configOpts(command, configDir))
    emitCommandResult(result, command, pretty)
  })

// --- build | push | pull: OCI package lifecycle (top-level, docker-style) ---
program.addCommand(
  buildBuildCommand().action(async (options: BuildCommandOptions, command: Command) => {
    const result = await executeCommand(
      { kind: "build", req: buildArgsFromOptions(options) },
      configOpts(command, options.configDir),
    )
    emitResult("build", resultData(result), prettyOpts(command))
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
      const result = await executeCommand(
        { kind: "models", req: modelsArgsFromOptions(provider, options) },
        configOpts(command, options.configDir),
      )
      emitCommandResult(result, command)
    },
  ),
)

// --- generate / gen ---
program.addCommand(buildGenerateCommand().alias("gen"))

// --- package: store management (list / ls, rm) ---
program.addCommand(buildPackageCommand())

// --- tag: point a new store ref at an existing one (docker tag semantics) ---
program.addCommand(addGlobalOptions(buildTagCommand()))

// --- bare invocation / unknown top-level command ---
program.action((_options, command) => {
  const unknown = command.args[0]
  if (unknown === undefined) {
    command.help()
    return
  }
  throw usageError(`unknown command: ${unknown} (run 'creatifact --help' to list commands)`)
})

/** Emit a CommandResult as the unified JSON envelope. */
function emitCommandResult(result: FileRunResult, command: Command, pretty?: boolean): void {
  const style = pretty === true ? { pretty: true } : prettyOpts(command)
  emitResult(result.kind, resultData(result), style)
}

/** Strip --config-dir/--pretty from -f passthrough args (they bypass commander options). */
function extractPassthroughFlags(args: string[]): {
  rest: string[]
  configDir?: string
  pretty?: boolean
} {
  const rest: string[] = []
  let configDir: string | undefined
  let pretty: boolean | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) continue
    if (arg === "--config-dir") {
      configDir = takePairValue(args, i)
      i++
      continue
    }
    if (arg === "--pretty") {
      pretty = true
      continue
    }
    rest.push(arg)
  }
  return configDir === undefined && pretty === undefined
    ? { rest }
    : {
        rest,
        ...(configDir === undefined ? {} : { configDir }),
        ...(pretty === undefined ? {} : { pretty }),
      }
}

/** The value paired with a --flag arg (throws when missing). */
function takePairValue(args: string[], i: number): string {
  const dir = args[i + 1]
  if (dir === undefined || dir === "") {
    throw usageError("--config-dir requires a directory")
  }
  return dir
}

program.parseAsync(process.argv).then(
  () => process.exit(0),
  (e: unknown) => {
    // Help/version events already wrote their text to stdout; keep exit 0.
    if (
      e instanceof CommanderError &&
      (e.code === "commander.help" ||
        e.code === "commander.helpDisplayed" ||
        e.code === "commander.helpCommand" ||
        e.code === "commander.version")
    ) {
      process.exit(0)
    }
    process.exit(emitError(undefined, e))
  },
)
