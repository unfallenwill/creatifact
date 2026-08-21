import { type ParsedArgs as BuildRequest, type BuildResult, runBuildFromParsed } from "./build"
import { type ConfigActionResult, runConfigAction } from "./configCmd"
import { type ParsedLoginArgs, runLoginFromParsed, runLogoutFromParsed } from "./login"
import { type ModelsResult, runModelsFromParsed } from "./models"
import { type ParsedPullArgs, type PullResult, runPullFromParsed } from "./pull"
import { type ParsedPushArgs, type PushResult, runPushFromParsed } from "./push"
import { executeRunRequest, type RunRequest, type RunResult } from "./run"

export type CommandRequest =
  | { kind: "build"; req: BuildRequest }
  | { kind: "push"; req: ParsedPushArgs }
  | { kind: "pull"; req: ParsedPullArgs }
  | { kind: "run"; req: RunRequest }
  | { kind: "login"; req: ParsedLoginArgs }
  | { kind: "logout"; req: { registry: string | undefined } }
  | { kind: "models"; req: { provider: string | undefined } }
  | { kind: "config"; action: string; rest: string[] }

export type CommandResult =
  | ({ kind: "build" } & BuildResult)
  | ({ kind: "push" } & PushResult)
  | ({ kind: "pull" } & PullResult)
  | ({ kind: "run" } & RunResult)
  | ({ kind: "config" } & ConfigActionResult)
  | ({ kind: "login" } & { registry: string; username: string })
  | ({ kind: "logout" } & { registry: string })
  | ({ kind: "models" } & ModelsResult)

export interface ExecuteContext {
  configPath?: string | undefined
  signal?: AbortSignal | undefined
}

/**
 * Single dispatch point for every command. The CLI (commander), `-f` JSON
 * files, and future step orchestration all normalize to a CommandRequest and
 * execute here; results carry the produced package data for callers that
 * need it (e.g. chained steps).
 */
export async function executeCommand(
  request: CommandRequest,
  ctx: ExecuteContext = {},
): Promise<CommandResult> {
  const opts = ctx.configPath === undefined ? {} : { configPath: ctx.configPath }
  switch (request.kind) {
    case "build":
      return { kind: "build", ...(await runBuildFromParsed(request.req, opts)) }
    case "push":
      return { kind: "push", ...(await runPushFromParsed(request.req, opts)) }
    case "pull":
      return { kind: "pull", ...(await runPullFromParsed(request.req, opts)) }
    case "run":
      return {
        kind: "run",
        ...(await executeRunRequest(request.req, opts)),
      }
    case "login":
      return { kind: "login", ...(await runLoginFromParsed(request.req, opts)) }
    case "logout":
      return { kind: "logout", ...(await runLogoutFromParsed(request.req, opts)) }
    case "models":
      return { kind: "models", ...(await runModelsFromParsed(request.req, opts)) }
    case "config":
      return { kind: "config", ...runConfigAction(request.action, request.rest, opts) }
  }
}

/** The envelope payload of a result: its own fields, minus the `kind` tag. */
export function resultData(result: CommandResult): Record<string, unknown> {
  const { kind: _kind, ...data } = result
  return data as Record<string, unknown>
}
