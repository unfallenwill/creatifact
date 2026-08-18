import { type BuildResult, type ParsedArgs as BuildRequest, runBuildFromParsed } from "./build"
import { runConfigAction } from "./configCmd"
import { type GenRequest, type GenerateResult, runGenerateRequest } from "./generate"
import { type ParsedLoginArgs, runLoginFromParsed, runLogoutFromParsed } from "./login"
import { runModelsFromParsed } from "./models"
import { type ParsedPullArgs, type PullResult, runPullFromParsed } from "./pull"
import { type ParsedPushArgs, type PushResult, runPushFromParsed } from "./push"

export type CommandRequest =
  | { kind: "build"; req: BuildRequest }
  | { kind: "push"; req: ParsedPushArgs }
  | { kind: "pull"; req: ParsedPullArgs }
  | { kind: "generate"; req: GenRequest }
  | { kind: "login"; req: ParsedLoginArgs }
  | { kind: "logout"; req: { registry: string | undefined } }
  | { kind: "models"; req: { provider: string | undefined; json: boolean } }
  | { kind: "config"; action: string; rest: string[] }

export type CommandResult =
  | ({ kind: "build" } & BuildResult)
  | ({ kind: "push" } & PushResult)
  | ({ kind: "pull" } & PullResult)
  | ({ kind: "generate" } & GenerateResult)
  | { kind: "void" }

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
    case "generate":
      return { kind: "generate", ...(await runGenerateRequest(request.req, opts)) }
    case "login":
      await runLoginFromParsed(request.req, opts)
      return { kind: "void" }
    case "logout":
      await runLogoutFromParsed(request.req, opts)
      return { kind: "void" }
    case "models":
      await runModelsFromParsed(request.req, opts)
      return { kind: "void" }
    case "config":
      runConfigAction(request.action, request.rest, opts)
      return { kind: "void" }
  }
}
