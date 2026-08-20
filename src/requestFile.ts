import { readFileSync } from "node:fs"
import type { z } from "zod"
import type { ParsedArgs as BuildRequest } from "./build"
import {
  buildRequestFields,
  configGetFields,
  configSetFields,
  type Fields,
  type GenerateFieldJson,
  generateRequestFields,
  loginRequestFields,
  logoutRequestFields,
  modelsRequestFields,
  nonEmptyString,
  normalizeBuildField,
  normalizeGenerateField,
  pullRequestFields,
  pushRequestFields,
} from "./contract"
import { usageError } from "./errors"
import type { CommandRequest } from "./execute"
import type { GenRequest, GenTaskName } from "./generate"
import { stripJsonc } from "./jsonc"
import type { ParsedLoginArgs } from "./login"
import type { ParsedPullArgs } from "./pull"
import type { ParsedPushArgs } from "./push"
import { requestFieldsForTask, TASKS } from "./tasks"

export type { Fields }

/**
 * Field-level validators and normalizers live in contract.ts (the single
 * source of truth shared with the generated JSON Schemas); this module only
 * orchestrates: it gates unknown fields per command, parses each present
 * field through its contract schema, and maps failures to usage errors.
 */

/** Parse one field through its contract schema; failure becomes a usage error. */
function parseField<T>(schema: z.ZodType<T>, value: unknown, field: string): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    const message = result.error.issues[0]?.message ?? "failed validation"
    throw usageError(`field '${field}' ${message}`)
  }
  return result.data as T
}

/** Parse an optional field: absent input stays undefined. */
function optField<T>(schema: z.ZodType<T>, value: unknown, field: string): T | undefined {
  return value === undefined ? undefined : parseField(schema, value, field)
}

export function rejectUnknown(fields: Fields, allowed: ReadonlySet<string>, command: string): void {
  for (const key of Object.keys(fields)) {
    if (!allowed.has(key)) {
      throw usageError(
        `unknown field '${key}' for command '${command}' (allowed: ${[...allowed].sort().join(", ")})`,
      )
    }
  }
}

/** Build a GenRequest from a generate.<task> file's fields. */
export function generateRequest(task: GenTaskName, fields: Fields): GenRequest {
  rejectUnknown(fields, requestFieldsForTask(task), `generate.${task}`)

  const req: GenRequest = { task }
  for (const field of Object.keys(generateRequestFields) as GenerateJsonField[]) {
    const value = fields[field]
    if (value === undefined) continue
    assignGenerateField(req, field, value)
  }
  return req
}

/** Generate-request fields that come from `-f` JSON (not task/internals). */
type GenerateJsonField = Exclude<keyof GenRequest, "task" | "promptRef" | "inputRefs"> & string

/** Parse + normalize one field and write it onto req, type-safely end to end. */
function assignGenerateField<K extends keyof GenRequest & string>(
  req: GenRequest,
  field: K,
  value: unknown,
): void {
  const table = generateRequestFields as Record<string, z.ZodType>
  const schema = table[field]
  // Unreachable in practice: field enumerates the table's own keys.
  if (schema === undefined) return
  const parsed: unknown = parseField(schema, value, field)
  req[field] = normalizeGenerateField(field, parsed as GenerateFieldJson<K>)
}

export function buildRequest(fields: Fields): BuildRequest {
  rejectUnknown(fields, new Set(Object.keys(buildRequestFields)), "build")
  const annotations =
    fields["annotations"] === undefined
      ? {}
      : (normalizeBuildField(
          "annotations",
          parseField(buildRequestFields.annotations, fields["annotations"], "annotations"),
        ) as Record<string, string>)
  const req: BuildRequest = {
    tag: parseField(buildRequestFields.tag, fields["tag"], "tag"),
    annotations,
    passwordStdin: false,
    plainHttp: optField(buildRequestFields.plainHttp, fields["plainHttp"], "plainHttp") ?? false,
  }
  for (const field of BUILD_OPTIONAL_FIELDS) {
    const parsed = optField(buildRequestFields[field], fields[field], field)
    if (parsed !== undefined) assignBuildField(req, field, parsed)
  }
  return req
}

/** build's optional -f fields (absent stays absent under exactOptionalPropertyTypes). */
const BUILD_OPTIONAL_FIELDS = ["dir", "file", "output", "username", "password"] as const

/** Write one optional build field onto req (generic-key write needs a helper). */
function assignBuildField<K extends (typeof BUILD_OPTIONAL_FIELDS)[number]>(
  req: BuildRequest,
  field: K,
  value: NonNullable<BuildRequest[K]>,
): void {
  req[field] = value
}

export function pushRequest(fields: Fields): ParsedPushArgs {
  rejectUnknown(fields, new Set(Object.keys(pushRequestFields)), "push")
  return {
    ref: parseField(pushRequestFields.ref, fields["ref"], "ref"),
    layout: optField(pushRequestFields.layout, fields["layout"], "layout"),
    username: optField(pushRequestFields.username, fields["username"], "username"),
    password: optField(pushRequestFields.password, fields["password"], "password"),
    passwordStdin: false,
    plainHttp: optField(pushRequestFields.plainHttp, fields["plainHttp"], "plainHttp") ?? false,
  }
}

export function pullRequest(fields: Fields): ParsedPullArgs {
  rejectUnknown(fields, new Set(Object.keys(pullRequestFields)), "pull")
  return {
    ref: parseField(pullRequestFields.ref, fields["ref"], "ref"),
    output: optField(pullRequestFields.output, fields["output"], "output"),
    username: optField(pullRequestFields.username, fields["username"], "username"),
    password: optField(pullRequestFields.password, fields["password"], "password"),
    passwordStdin: false,
    plainHttp: optField(pullRequestFields.plainHttp, fields["plainHttp"], "plainHttp") ?? false,
  }
}

export function loginRequest(fields: Fields): ParsedLoginArgs {
  rejectUnknown(fields, new Set(Object.keys(loginRequestFields)), "auth.login")
  return {
    registry: parseField(loginRequestFields.registry, fields["registry"], "registry"),
    username: optField(loginRequestFields.username, fields["username"], "username"),
    password: optField(loginRequestFields.password, fields["password"], "password"),
    passwordStdin: false,
  }
}

/** Parse a request file's contents into either a single command or steps. */
export function readRequestFile(file: string): { command: string; fields: Fields } {
  let raw: string
  try {
    raw = readFileSync(file, "utf8")
  } catch (e) {
    throw usageError(`cannot read request file '${file}': ${(e as Error).message}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stripJsonc(raw))
  } catch (e) {
    throw usageError(`'${file}' is not valid JSON/JSONC: ${(e as Error).message}`)
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw usageError(`'${file}' must contain a JSON object`)
  }
  const root = { ...(parsed as Fields) }
  delete root["$schema"]

  // Orchestration moved to the build manifest (stages): -f files are the
  // exact JSON mirror of a single command line.
  if (root["pipeline"] !== undefined || root["parallel"] !== undefined) {
    throw usageError(
      "-f files carry a single command; orchestration (pipeline/parallel) lives in creatifact-build.json stages",
    )
  }

  const command = parseField(nonEmptyString, root["command"], "command")
  delete root["command"]
  return { command, fields: root }
}

/**
 * Turn a request-file command + its fields into a CommandRequest (no CLI
 * overlay). Shared by the single-command `-f` path and pipeline steps.
 */
export function commandRequestFromFields(command: string, fields: Fields): CommandRequest {
  if (command.startsWith("generate.")) {
    const task = command.slice("generate.".length) as GenTaskName
    if (TASKS[task] === undefined) {
      throw usageError(`unknown generate task '${task}' in command '${command}'`)
    }
    return { kind: "generate", req: generateRequest(task, fields) }
  }
  switch (command) {
    case "build":
      return { kind: "build", req: buildRequest(fields) }
    case "push":
      return { kind: "push", req: pushRequest(fields) }
    case "pull":
      return { kind: "pull", req: pullRequest(fields) }
    case "auth.login":
      return { kind: "login", req: loginRequest(fields) }
    case "auth.logout": {
      rejectUnknown(fields, new Set(Object.keys(logoutRequestFields)), command)
      return {
        kind: "logout",
        req: { registry: parseField(logoutRequestFields.registry, fields["registry"], "registry") },
      }
    }
    case "config.path":
    case "config.list":
    case "config.reset": {
      rejectUnknown(fields, new Set(), command)
      return { kind: "config", action: command.slice("config.".length), rest: [] }
    }
    case "config.get": {
      rejectUnknown(fields, new Set(Object.keys(configGetFields)), command)
      return {
        kind: "config",
        action: "get",
        rest: [parseField(configGetFields.key, fields["key"], "key")],
      }
    }
    case "config.set": {
      rejectUnknown(fields, new Set(Object.keys(configSetFields)), command)
      const key = parseField(configSetFields.key, fields["key"], "key")
      const value = fields["value"]
      if (value === undefined) {
        throw usageError("command 'config.set' requires field 'value'")
      }
      return { kind: "config", action: "set", rest: [key, JSON.stringify(value)] }
    }
    case "models": {
      rejectUnknown(fields, new Set(Object.keys(modelsRequestFields)), command)
      return {
        kind: "models",
        req: {
          provider: optField(modelsRequestFields.provider, fields["provider"], "provider"),
        },
      }
    }
    default:
      throw usageError(
        `unknown command '${command}' (expected generate.*, build, push, pull, auth.*, config.*, or models)`,
      )
  }
}
