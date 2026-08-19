import { defaultGenProvider, loadConfig } from "./config"
import { executeCommand } from "./execute"
import {
  type GenerateResult,
  type GenTaskName,
  mergeRequest,
  parseGenerateArgs,
  runGenerateRequest,
  TASKS,
} from "./generate"
import { runPipeline } from "./pipeline"
import { listConfiguredProviderIds } from "./providers"
import {
  commandRequestFromFields,
  type Fields,
  generateRequest,
  readRequestFile,
} from "./requestFile"

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
    throw new Error(`unknown generate task '${task}' in command '${command}'`)
  }
  // Command-line flags after the file override the file's fields.
  const overlay = parseGenerateArgs(task, args, fileOverlayContext(opts), {
    packageMode: true,
  })
  return runGenerateRequest(mergeRequest(generateRequest(task, fields), overlay), opts)
}

export async function runFileFromArgs(args: string[], opts: FileRunOptions = {}): Promise<void> {
  const file = args[0]
  if (file === undefined || file === "") {
    throw new Error("-f requires a JSON file path, e.g. creatifact -f request.json")
  }
  const parsed = readRequestFile(file)

  if ("steps" in parsed) {
    if (args.length > 1) {
      throw new Error("command-line flags are not supported with a steps file")
    }
    await runPipeline(parsed.steps, opts)
    return
  }

  const { command, fields } = parsed
  if (command.startsWith("generate.")) {
    await runFileGenerate(command, fields, args.slice(1), opts)
    return
  }

  await executeCommand(commandRequestFromFields(command, fields), opts)
}
