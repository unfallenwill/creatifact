import { readFileSync } from "node:fs"
import { runBuildFromArgs } from "./build"
import { defaultGenProvider, loadConfig } from "./config"
import { runConfigFromArgs } from "./configCmd"
import {
  type GenRequest,
  type GenTaskName,
  mergeRequest,
  parseGenerateArgs,
  requestFieldsForTask,
  runGenerateRequest,
  TASKS,
} from "./generate"
import { runLoginFromArgs, runLogoutFromArgs } from "./login"
import { runModelsFromArgs } from "./models"
import { listConfiguredProviderIds } from "./providers"
import { runPullFromArgs } from "./pull"
import { runPushFromArgs } from "./push"

export const FILE_USAGE = `Usage: openmmcli -f <file>.json [options] [-- generate flags]

Run the command described by a JSON file. The file must be an object with a
"command" field selecting what to do; the remaining fields map to that
command's arguments. Commands mirror the CLI subcommand tree:

  generate.text2text / generate.image2text / generate.video2text
  generate.text2image / generate.image2image
  generate.text2video / generate.image2video / generate.frames2video
  generate.embed / generate.resume
  package.build / package.push / package.pull
  auth.login / auth.logout
  config.path / config.list / config.get / config.set / config.reset
  models

For generate.* commands, flags after the file override the file's fields
(command line wins):

  openmmcli -f req.json --prompt "a red crane" --opt size=2048x2048

Examples:
  {"command":"generate.image2image","provider":"zhipu","prompt":"a crane",
   "images":["https://…/cat.png"],"options":{"size":"1024x1024"}}
  {"command":"generate.text2video","provider":"ark","prompt":"…","noWait":true}
  {"command":"package.build","tag":"org/app:1.0.0","file":"./openmm-build.json"}
  {"command":"auth.login","registry":"localhost:5000","username":"u","password":"p"}

Global options:
  --config-dir <dir>    Use <dir>/config.json instead of ~/.openmmcli/config.json`

type Fields = Record<string, unknown>

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`field '${field}' must be a non-empty string`)
  }
  return value
}

function asOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  return asString(value, field)
}

function asBool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`field '${field}' must be a boolean`)
  }
  return value
}

function asOptionalBool(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined
  return asBool(value, field)
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
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

function rejectUnknown(fields: Fields, allowed: ReadonlySet<string>, command: string): void {
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
function generateRequest(task: GenTaskName, fields: Fields): GenRequest {
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

function buildArgv(fields: Fields): string[] {
  rejectUnknown(
    fields,
    new Set(["tag", "dir", "file", "output", "annotations", "username", "password", "plainHttp"]),
    "package.build",
  )
  const argv: string[] = []
  const tag = asString(fields["tag"], "tag")
  argv.push("--tag", tag)
  const dir = asOptionalString(fields["dir"], "dir")
  if (dir !== undefined) argv.push("--dir", dir)
  const file = asOptionalString(fields["file"], "file")
  if (file !== undefined) argv.push("--file", file)
  const output = asOptionalString(fields["output"], "output")
  if (output !== undefined) argv.push("--output", output)
  const annotations = fields["annotations"]
  if (annotations !== undefined) {
    for (const [key, value] of Object.entries(asRecord(annotations, "annotations"))) {
      argv.push("--annotation", `${key}=${String(value)}`)
    }
  }
  const username = asOptionalString(fields["username"], "username")
  if (username !== undefined) argv.push("--username", username)
  const password = asOptionalString(fields["password"], "password")
  if (password !== undefined) argv.push("--password", password)
  if (asOptionalBool(fields["plainHttp"], "plainHttp") === true) argv.push("--plain-http")
  return argv
}

function registryArgv(
  fields: Fields,
  command: "package.push" | "package.pull" | "auth.login" | "auth.logout",
): string[] {
  const allowed: Record<string, ReadonlySet<string>> = {
    "package.push": new Set(["ref", "layout", "username", "password", "plainHttp"]),
    "package.pull": new Set(["ref", "output", "username", "password", "plainHttp"]),
    "auth.login": new Set(["registry", "username", "password"]),
    "auth.logout": new Set(["registry"]),
  }
  const fieldsAllowed = allowed[command]
  if (fieldsAllowed === undefined) throw new Error(`unknown command '${command}'`)
  rejectUnknown(fields, fieldsAllowed, command)

  const argv: string[] = []
  if (command === "auth.login" || command === "auth.logout") {
    argv.push(asString(fields["registry"], "registry"))
  } else {
    argv.push(asString(fields["ref"], "ref"))
    const layout = asOptionalString(fields["layout"], "layout")
    if (layout !== undefined) argv.push("--layout", layout)
  }
  if (command !== "auth.logout") {
    const output = asOptionalString(fields["output"], "output")
    if (output !== undefined) argv.push("--output", output)
    const username = asOptionalString(fields["username"], "username")
    if (username !== undefined) argv.push("--username", username)
    const password = asOptionalString(fields["password"], "password")
    if (password !== undefined) argv.push("--password", password)
    if (asOptionalBool(fields["plainHttp"], "plainHttp") === true) argv.push("--plain-http")
  }
  return argv
}

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

/** Parse a request file's contents into (command, fields). */
function readRequestFile(file: string): { command: string; fields: Fields } {
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

/** Dispatch a generate.<task> command with CLI flags overriding file fields. */
async function runFileGenerate(
  command: string,
  fields: Fields,
  args: string[],
  opts: FileRunOptions,
): Promise<void> {
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
    throw new Error("-f requires a JSON file path, e.g. openmmcli -f request.json")
  }
  const { command, fields } = readRequestFile(file)

  if (command.startsWith("generate.")) {
    return runFileGenerate(command, fields, args.slice(1), opts)
  }

  switch (command) {
    case "package.build":
      return runBuildFromArgs(buildArgv(fields), opts)
    case "package.push":
      return runPushFromArgs(registryArgv(fields, "package.push"), opts)
    case "package.pull":
      return runPullFromArgs(registryArgv(fields, "package.pull"), opts)
    case "auth.login":
      return runLoginFromArgs(registryArgv(fields, "auth.login"), opts)
    case "auth.logout":
      return runLogoutFromArgs(registryArgv(fields, "auth.logout"), opts)
    case "config.path":
    case "config.list":
    case "config.reset": {
      rejectUnknown(fields, new Set(), command)
      return runConfigFromArgs([command.slice("config.".length)], opts)
    }
    case "config.get": {
      rejectUnknown(fields, new Set(["key"]), command)
      return runConfigFromArgs(["get", asString(fields["key"], "key")], opts)
    }
    case "config.set": {
      rejectUnknown(fields, new Set(["key", "value"]), command)
      const key = asString(fields["key"], "key")
      if (fields["value"] === undefined) {
        throw new Error("command 'config.set' requires field 'value'")
      }
      return runConfigFromArgs(["set", key, JSON.stringify(fields["value"])], opts)
    }
    case "models": {
      rejectUnknown(fields, new Set(["provider", "json"]), command)
      const argv: string[] = []
      const provider = asOptionalString(fields["provider"], "provider")
      if (provider !== undefined) argv.push(provider)
      if (asOptionalBool(fields["json"], "json") === true) argv.push("--json")
      return runModelsFromArgs(argv, opts)
    }
    default:
      throw new Error(
        `unknown command '${command}' (expected generate.*, package.*, auth.*, config.*, or models)`,
      )
  }
}
