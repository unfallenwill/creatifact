import { defaultGenProvider, loadConfig } from "./config"
import { usageError } from "./errors"
import { type CommandResult, executeCommand } from "./execute"
import {
  type GenerateResult,
  type GenTaskName,
  mergeRequest,
  parseGenerateArgs,
  runGenerateRequest,
  TASKS,
} from "./generate"
import { listConfiguredProviderIds } from "./providers"
import {
  commandRequestFromFields,
  type Fields,
  generateRequest,
  readRequestFile,
} from "./requestFile"

export type FileRunResult = CommandResult

export interface FileRunOptions {
  configPath?: string
}

function fileOverlayContext(opts: FileRunOptions) {
  const config = loadConfig(opts.configPath)
  return {
    known: new Set(listConfiguredProviderIds(opts)),
    hasDefaultProvider: defaultGenProvider(config) !== undefined,
  }
}

/** Dispatch a generate.<task> command with CLI flags overriding file fields. */
async function runFileGenerate(
  command: string,
  fields: Fields,
  args: string[],
  opts: FileRunOptions,
): Promise<GenerateResult> {
  const task = command.slice("generate.".length) as GenTaskName
  if (TASKS[task] === undefined) {
    throw usageError(`unknown generate task '${task}' in command '${command}'`)
  }
  // Command-line flags after the file override the file's fields.
  const overlay = parseGenerateArgs(task, args, fileOverlayContext(opts), {
    packageMode: true,
  })
  return runGenerateRequest(mergeRequest(generateRequest(task, fields), overlay), opts)
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
  if (command.startsWith("generate.")) {
    const r = await runFileGenerate(command, fields, args.slice(1), opts)
    return { kind: "generate", ...r }
  }

  return executeCommand(commandRequestFromFields(command, fields), opts)
}
