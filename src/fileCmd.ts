import { defaultGenProvider, loadConfig, parallelConcurrency } from "./config"
import { usageError } from "./errors"
import { type CommandResult, executeCommand, resultData } from "./execute"
import {
  type GenerateResult,
  type GenTaskName,
  mergeRequest,
  parseGenerateArgs,
  runGenerateRequest,
  TASKS,
} from "./generate"
import { interruptSignal } from "./interrupt"
import { type PipelineRunResult, runParallel, runPipeline } from "./pipeline"
import { listConfiguredProviderIds } from "./providers"
import {
  commandRequestFromFields,
  type Fields,
  generateRequest,
  readRequestFile,
} from "./requestFile"

/** A pipeline summary: per-step kind + data (the envelope's data), plus
 * steps that never ran when a failure skips the rest. */
export interface PipelineSummary {
  kind: "pipeline"
  steps: Array<{ name?: string; command: string; kind: string; data: Record<string, unknown> }>
  skipped?: Array<{ name?: string; command: string; reason: string }>
}

/** Render a steps/parallel run as the pipeline summary envelope. */
function pipelineSummary(run: PipelineRunResult): PipelineSummary {
  return {
    kind: "pipeline",
    steps: run.steps.map((s) => ({
      ...(s.name === undefined ? {} : { name: s.name }),
      command: s.command,
      kind: s.result.kind,
      data: resultData(s.result),
    })),
    ...(run.skipped.length === 0
      ? {}
      : {
          skipped: run.skipped.map((s) => ({
            ...(s.name === undefined ? {} : { name: s.name }),
            command: s.command,
            reason: s.reason,
          })),
        }),
  }
}

export type FileRunResult = CommandResult | PipelineSummary

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

  if ("parallel" in parsed) {
    if (args.length > 1) {
      throw usageError("command-line flags are not supported with a parallel file")
    }
    const run = await runParallel(parsed.parallel, {
      configPath: opts.configPath,
      signal: interruptSignal(),
      concurrency: parallelConcurrency(loadConfig(opts.configPath)),
    })
    return pipelineSummary(run)
  }

  if ("pipeline" in parsed) {
    if (args.length > 1) {
      throw usageError("command-line flags are not supported with a pipeline file")
    }
    const run = await runPipeline(parsed.pipeline, {
      configPath: opts.configPath,
      signal: interruptSignal(),
    })
    return pipelineSummary(run)
  }

  const { command, fields } = parsed
  if (command.startsWith("generate.")) {
    const r = await runFileGenerate(command, fields, args.slice(1), opts)
    return { kind: "generate", ...r }
  }

  return executeCommand(commandRequestFromFields(command, fields), opts)
}
