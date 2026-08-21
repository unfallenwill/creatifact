import { defaultRunProvider, loadConfig } from "./config"
import { usageError } from "./errors"
import { type CommandResult, executeCommand } from "./execute"
import { listConfiguredProviderIds } from "./providers"
import {
  commandRequestFromFields,
  type Fields,
  readRequestFile,
  runRequestFromFields,
} from "./requestFile"
import {
  executeRunRequest,
  mergeRequest,
  parseRunArgs,
  type RunResult,
  type RunTaskName,
  TASKS,
} from "./run"

export type FileRunResult = CommandResult

export interface FileRunOptions {
  configPath?: string
}

function fileOverlayContext(opts: FileRunOptions) {
  const config = loadConfig(opts.configPath)
  return {
    known: new Set(listConfiguredProviderIds(opts)),
    hasDefaultProvider: defaultRunProvider(config) !== undefined,
  }
}

/** Dispatch a run.<task> command with CLI flags overriding file fields. */
async function runFileTask(
  command: string,
  fields: Fields,
  args: string[],
  opts: FileRunOptions,
): Promise<RunResult> {
  const task = command.slice("run.".length) as RunTaskName
  if (TASKS[task] === undefined) {
    throw usageError(`unknown task '${task}' in command '${command}'`)
  }
  // Command-line flags after the file override the file's fields.
  const overlay = parseRunArgs(task, args, fileOverlayContext(opts), {
    packageMode: true,
  })
  return executeRunRequest(mergeRequest(runRequestFromFields(task, fields), overlay), opts)
}

export async function runFileFromArgs(
  args: string[],
  opts: FileRunOptions = {},
): Promise<FileRunResult> {
  const file = args[0]
  if (file === undefined || file === "") {
    throw usageError("-f requires a JSON file path, e.g. creatifact -f request.json")
  }
  const parsed = readRequestFile(file)

  const { command, fields } = parsed
  if (command.startsWith("run.")) {
    const r = await runFileTask(command, fields, args.slice(1), opts)
    return { kind: "run", ...r }
  }

  return executeCommand(commandRequestFromFields(command, fields), opts)
}
