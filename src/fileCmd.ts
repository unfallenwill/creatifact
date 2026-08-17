import { readFileSync } from "node:fs"
import { runBuildFromArgs } from "./build"
import { runConfigFromArgs } from "./configCmd"
import { type GenLane, runGenFromArgs } from "./gen"
import { runLoginFromArgs, runLogoutFromArgs } from "./login"
import { runModelsFromArgs } from "./models"
import { runPullFromArgs } from "./pull"
import { runPushFromArgs } from "./push"

export const FILE_USAGE = `Usage: openmmcli -f <file>.json [options]

Run the command described by a JSON file. The file must be an object with a
"command" field selecting what to do; the remaining fields map to that
command's arguments. Commands mirror the CLI subcommand tree:

  gen.text / gen.image / gen.video / gen.understand / gen.embed / gen.resume
  package.build / package.push / package.pull
  auth.login / auth.logout
  config.path / config.list / config.get / config.set / config.reset
  models

Examples:
  {"command":"gen.image","provider":"zhipu","prompt":"a crane",
   "options":{"size":"1024x1024"}}
  {"command":"gen.video","provider":"ark/doubao-seedance-2.0","prompt":"...",
   "noWait":true}
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
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return value as string[]
  }
  throw new Error(`field '${field}' must be a string or an array of strings`)
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

function targetArg(fields: Fields): string | undefined {
  const provider = asOptionalString(fields["provider"], "provider")
  const model = asOptionalString(fields["model"], "model")
  if (provider === undefined) {
    if (model !== undefined) {
      throw new Error("field 'model' requires field 'provider'")
    }
    return undefined
  }
  return model === undefined ? provider : `${provider}/${model}`
}

function optionArgs(fields: Fields): string[] {
  const options = fields["options"]
  if (options === undefined) return []
  const record = asRecord(options, "options")
  const out: string[] = []
  for (const [key, value] of Object.entries(record)) {
    out.push("--opt", `${key}=${JSON.stringify(value)}`)
  }
  return out
}

function pushJson(fields: Fields, argv: string[]): void {
  if (asOptionalBool(fields["json"], "json") === true) argv.push("--json")
}

function textArgv(fields: Fields): string[] {
  rejectUnknown(
    fields,
    new Set(["provider", "model", "prompt", "system", "options", "json"]),
    "gen.text",
  )
  const argv: string[] = []
  const target = targetArg(fields)
  if (target !== undefined) argv.push(target)
  const prompt = asOptionalString(fields["prompt"], "prompt")
  if (prompt !== undefined) argv.push(prompt)
  const system = asOptionalString(fields["system"], "system")
  if (system !== undefined) argv.push("--system", system)
  argv.push(...optionArgs(fields))
  pushJson(fields, argv)
  return argv
}

function imageArgv(fields: Fields): string[] {
  rejectUnknown(
    fields,
    new Set(["provider", "model", "prompt", "image", "options", "output", "json"]),
    "gen.image",
  )
  const argv: string[] = []
  const target = targetArg(fields)
  if (target !== undefined) argv.push(target)
  const prompt = asOptionalString(fields["prompt"], "prompt")
  if (prompt !== undefined) argv.push(prompt)
  const image = asOptionalString(fields["image"], "image")
  if (image !== undefined) argv.push("--image", image)
  const output = asOptionalString(fields["output"], "output")
  if (output !== undefined) argv.push("--output", output)
  argv.push(...optionArgs(fields))
  pushJson(fields, argv)
  return argv
}

function videoArgv(fields: Fields): string[] {
  rejectUnknown(
    fields,
    new Set([
      "provider",
      "model",
      "prompt",
      "firstFrame",
      "lastFrame",
      "options",
      "noWait",
      "timeout",
      "interval",
      "output",
      "json",
    ]),
    "gen.video",
  )
  const argv: string[] = []
  const target = targetArg(fields)
  if (target !== undefined) argv.push(target)
  const prompt = asOptionalString(fields["prompt"], "prompt")
  if (prompt !== undefined) argv.push(prompt)
  const firstFrame = asOptionalString(fields["firstFrame"], "firstFrame")
  if (firstFrame !== undefined) argv.push("--first-frame", firstFrame)
  const lastFrame = asOptionalString(fields["lastFrame"], "lastFrame")
  if (lastFrame !== undefined) argv.push("--last-frame", lastFrame)
  if (asOptionalBool(fields["noWait"], "noWait") === true) argv.push("--no-wait")
  const timeout = fields["timeout"]
  if (timeout !== undefined) argv.push("--timeout", durationArg(timeout, "timeout"))
  const interval = fields["interval"]
  if (interval !== undefined) argv.push("--interval", durationArg(interval, "interval"))
  const output = asOptionalString(fields["output"], "output")
  if (output !== undefined) argv.push("--output", output)
  argv.push(...optionArgs(fields))
  pushJson(fields, argv)
  return argv
}

function understandArgv(fields: Fields): string[] {
  rejectUnknown(
    fields,
    new Set(["provider", "model", "ask", "input", "options", "json"]),
    "gen.understand",
  )
  const argv: string[] = []
  const target = targetArg(fields)
  if (target !== undefined) argv.push(target)
  const ask = asOptionalString(fields["ask"], "ask")
  if (ask !== undefined) argv.push(ask)
  const input = fields["input"]
  if (input !== undefined) {
    for (const item of asStringArray(input, "input")) argv.push("--input", item)
  }
  argv.push(...optionArgs(fields))
  pushJson(fields, argv)
  return argv
}

function embedArgv(fields: Fields): string[] {
  rejectUnknown(fields, new Set(["provider", "model", "input", "options", "json"]), "gen.embed")
  const argv: string[] = []
  const target = targetArg(fields)
  if (target !== undefined) argv.push(target)
  const input = fields["input"]
  if (input !== undefined) {
    for (const item of asStringArray(input, "input")) argv.push("--input", item)
  }
  argv.push(...optionArgs(fields))
  pushJson(fields, argv)
  return argv
}

function genArgv(lane: Exclude<GenLane, "resume">, fields: Fields): string[] {
  switch (lane) {
    case "text":
      return textArgv(fields)
    case "image":
      return imageArgv(fields)
    case "video":
      return videoArgv(fields)
    case "understand":
      return understandArgv(fields)
    case "embed":
      return embedArgv(fields)
  }
}

function resumeArgv(fields: Fields): string[] {
  rejectUnknown(
    fields,
    new Set(["handle", "file", "timeout", "interval", "output", "json"]),
    "gen.resume",
  )
  const argv: string[] = []
  const handle = fields["handle"]
  const file = asOptionalString(fields["file"], "file")
  if (handle !== undefined && file !== undefined) {
    throw new Error("fields 'handle' and 'file' are mutually exclusive")
  }
  if (handle !== undefined) {
    argv.push(typeof handle === "string" ? handle : JSON.stringify(handle))
  } else if (file !== undefined) {
    argv.push(file)
  }
  const timeout = fields["timeout"]
  if (timeout !== undefined) argv.push("--timeout", durationArg(timeout, "timeout"))
  const interval = fields["interval"]
  if (interval !== undefined) argv.push("--interval", durationArg(interval, "interval"))
  const output = asOptionalString(fields["output"], "output")
  if (output !== undefined) argv.push("--output", output)
  if (asOptionalBool(fields["json"], "json") === true) argv.push("--json")
  return argv
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

export async function runFileFromArgs(args: string[], opts: FileRunOptions = {}): Promise<void> {
  const file = args[0]
  if (file === undefined || file === "") {
    throw new Error("-f requires a JSON file path, e.g. openmmcli -f request.json")
  }
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

  switch (command) {
    case "gen.text":
    case "gen.image":
    case "gen.video":
    case "gen.understand":
    case "gen.embed": {
      const lane = command.slice("gen.".length) as Exclude<GenLane, "resume">
      return runGenFromArgs([lane, ...genArgv(lane, fields)], opts)
    }
    case "gen.resume":
      return runGenFromArgs(["resume", ...resumeArgv(fields)], opts)
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
        `unknown command '${command}' (expected gen.*, package.*, auth.*, config.*, or models)`,
      )
  }
}
