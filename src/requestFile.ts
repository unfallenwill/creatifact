import { readFileSync } from "node:fs"
import type { ParsedArgs as BuildRequest } from "./build"
import type { CommandRequest } from "./execute"
import type { GenRequest, GenTaskName } from "./generate"
import { requestFieldsForTask, TASKS } from "./tasks"
import type { ParsedLoginArgs } from "./login"
import type { ParsedPullArgs } from "./pull"
import type { ParsedPushArgs } from "./push"

export type Fields = Record<string, unknown>

export function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`field '${field}' must be a non-empty string`)
  }
  return value
}

export function asOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  return asString(value, field)
}

export function asBool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`field '${field}' must be a boolean`)
  }
  return value
}

export function asOptionalBool(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined
  return asBool(value, field)
}

export function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`field '${field}' must be an object`)
  }
  return value as Record<string, unknown>
}

function asStringArray(value: unknown, field: string): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value) && value.every((v) => typeof v === "string" && v !== "")) {
    return value as string[]
  }
  throw new Error(`field '${field}' must be a string or an array of non-empty strings`)
}

function asOptionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined
  return asStringArray(value, field)
}

/** Accept "5m" durations or numbers (milliseconds) for timeout/interval. */
function durationArg(value: unknown, field: string): string {
  if (typeof value === "string") return value
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value % 1000 === 0 ? `${Math.round(value / 1000)}s` : `${Math.round(value)}ms`
  }
  throw new Error(`field '${field}' must be a duration string (e.g. "5m") or milliseconds`)
}

export function rejectUnknown(fields: Fields, allowed: ReadonlySet<string>, command: string): void {
  for (const key of Object.keys(fields)) {
    if (!allowed.has(key)) {
      throw new Error(
        `unknown field '${key}' for command '${command}' (allowed: ${[...allowed].sort().join(", ")})`,
      )
    }
  }
}

/** String / string[] / bool / duration field readers for generate requests. */
function readGenerateStringFields(fields: Fields, req: GenRequest): void {
  for (const field of [
    "provider",
    "model",
    "prompt",
    "system",
    "firstFrame",
    "lastFrame",
    "output",
    "tag",
  ] as const) {
    const value = asOptionalString(fields[field], field)
    if (value !== undefined) req[field] = value
  }
}

function readGenerateListFields(fields: Fields, req: GenRequest): void {
  for (const field of ["images", "inputs"] as const) {
    const value = asOptionalStringArray(fields[field], field)
    if (value !== undefined) req[field] = value
  }
}

function readGenerateFlagFields(fields: Fields, req: GenRequest): void {
  for (const field of ["noWait", "noPack", "json"] as const) {
    const value = asOptionalBool(fields[field], field)
    if (value !== undefined) req[field] = value
  }
}

/** Build a GenRequest from a generate.<task> file's fields. */
export function generateRequest(task: GenTaskName, fields: Fields): GenRequest {
  rejectUnknown(fields, requestFieldsForTask(task), `generate.${task}`)

  const req: GenRequest = { task }
  readGenerateStringFields(fields, req)
  readGenerateListFields(fields, req)
  readGenerateFlagFields(fields, req)

  const options = fields["options"]
  if (options !== undefined) req.options = asRecord(options, "options")
  const timeout = fields["timeout"]
  if (timeout !== undefined) req.timeout = durationArg(timeout, "timeout")
  const interval = fields["interval"]
  if (interval !== undefined) req.interval = durationArg(interval, "interval")
  const handle = fields["handle"]
  if (handle !== undefined) {
    req.handle = typeof handle === "string" ? asString(handle, "handle") : JSON.stringify(handle)
  }
  return req
}

export function buildRequest(fields: Fields): BuildRequest {
  rejectUnknown(
    fields,
    new Set(["tag", "dir", "file", "output", "annotations", "username", "password", "plainHttp"]),
    "package.build",
  )
  const annotations: Record<string, string> = {}
  const rawAnnotations = fields["annotations"]
  if (rawAnnotations !== undefined) {
    for (const [key, value] of Object.entries(asRecord(rawAnnotations, "annotations"))) {
      annotations[key] = String(value)
    }
  }
  const req: BuildRequest = {
    tag: asString(fields["tag"], "tag"),
    annotations,
    passwordStdin: false,
    plainHttp: asOptionalBool(fields["plainHttp"], "plainHttp") === true,
  }
  const dir = asOptionalString(fields["dir"], "dir")
  if (dir !== undefined) req.dir = dir
  const file = asOptionalString(fields["file"], "file")
  if (file !== undefined) req.file = file
  const output = asOptionalString(fields["output"], "output")
  if (output !== undefined) req.output = output
  const username = asOptionalString(fields["username"], "username")
  if (username !== undefined) req.username = username
  const password = asOptionalString(fields["password"], "password")
  if (password !== undefined) req.password = password
  return req
}

export function pushRequest(fields: Fields): ParsedPushArgs {
  rejectUnknown(
    fields,
    new Set(["ref", "layout", "username", "password", "plainHttp"]),
    "package.push",
  )
  return {
    ref: asString(fields["ref"], "ref"),
    layout: asOptionalString(fields["layout"], "layout"),
    username: asOptionalString(fields["username"], "username"),
    password: asOptionalString(fields["password"], "password"),
    passwordStdin: false,
    plainHttp: asOptionalBool(fields["plainHttp"], "plainHttp") === true,
  }
}

export function pullRequest(fields: Fields): ParsedPullArgs {
  rejectUnknown(
    fields,
    new Set(["ref", "output", "username", "password", "plainHttp"]),
    "package.pull",
  )
  return {
    ref: asString(fields["ref"], "ref"),
    output: asOptionalString(fields["output"], "output"),
    username: asOptionalString(fields["username"], "username"),
    password: asOptionalString(fields["password"], "password"),
    passwordStdin: false,
    plainHttp: asOptionalBool(fields["plainHttp"], "plainHttp") === true,
  }
}

export function loginRequest(fields: Fields): ParsedLoginArgs {
  rejectUnknown(fields, new Set(["registry", "username", "password"]), "auth.login")
  return {
    registry: asString(fields["registry"], "registry"),
    username: asOptionalString(fields["username"], "username"),
    password: asOptionalString(fields["password"], "password"),
    passwordStdin: false,
  }
}

/** Parse a request file's contents into (command, fields). */
export function readRequestFile(file: string): { command: string; fields: Fields } {
  let raw: string
  try {
    raw = readFileSync(file, "utf8")
  } catch (e) {
    throw new Error(`cannot read request file '${file}': ${(e as Error).message}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(`'${file}' is not valid JSON: ${(e as Error).message}`)
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`'${file}' must contain a JSON object`)
  }
  const command = asString((parsed as Fields)["command"], "command")
  const fields: Fields = { ...(parsed as Fields) }
  delete fields["command"]
  delete fields["$schema"]
  return { command, fields }
}

/**
 * Turn a request-file command + its fields into a CommandRequest (no CLI
 * overlay). Shared by the single-command `-f` path and pipeline steps.
 */
export function commandRequestFromFields(command: string, fields: Fields): CommandRequest {
  if (command.startsWith("generate.")) {
    const task = command.slice("generate.".length) as GenTaskName
    if (TASKS[task] === undefined) {
      throw new Error(`unknown generate task '${task}' in command '${command}'`)
    }
    return { kind: "generate", req: generateRequest(task, fields) }
  }
  switch (command) {
    case "package.build":
      return { kind: "build", req: buildRequest(fields) }
    case "package.push":
      return { kind: "push", req: pushRequest(fields) }
    case "package.pull":
      return { kind: "pull", req: pullRequest(fields) }
    case "auth.login":
      return { kind: "login", req: loginRequest(fields) }
    case "auth.logout": {
      rejectUnknown(fields, new Set(["registry"]), command)
      return { kind: "logout", req: { registry: asString(fields["registry"], "registry") } }
    }
    case "config.path":
    case "config.list":
    case "config.reset": {
      rejectUnknown(fields, new Set(), command)
      return { kind: "config", action: command.slice("config.".length), rest: [] }
    }
    case "config.get": {
      rejectUnknown(fields, new Set(["key"]), command)
      return { kind: "config", action: "get", rest: [asString(fields["key"], "key")] }
    }
    case "config.set": {
      rejectUnknown(fields, new Set(["key", "value"]), command)
      const key = asString(fields["key"], "key")
      if (fields["value"] === undefined) {
        throw new Error("command 'config.set' requires field 'value'")
      }
      return { kind: "config", action: "set", rest: [key, JSON.stringify(fields["value"])] }
    }
    case "models": {
      rejectUnknown(fields, new Set(["provider", "json"]), command)
      return {
        kind: "models",
        req: {
          provider: asOptionalString(fields["provider"], "provider"),
          json: asOptionalBool(fields["json"], "json") === true,
        },
      }
    }
    default:
      throw new Error(
        `unknown command '${command}' (expected generate.*, package.*, auth.*, config.*, or models)`,
      )
  }
}
