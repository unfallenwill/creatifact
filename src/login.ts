import { isCancel, password as passwordPrompt, text } from "@clack/prompts"

import { encodeAuth, isValidRegistry, loadConfig, normalizeRegistry, saveConfig } from "./config"
import { parseCliArgs, resolvePassword } from "./util"

export const LOGIN_USAGE = `Usage: openmmcli auth login <registry> [options]

Save registry credentials to the openmmcli config file.

Arguments:
  <registry>             Registry host[:port] (e.g. localhost:5000, registry.example.com)

Options:
  -u, --username <user>  Registry username (prompted if omitted and interactive)
  -p, --password <pw>    Registry password (prefer --password-stdin)
      --password-stdin   Read password from stdin
  -h, --help             Show this help message

Credentials are stored base64-encoded in "auths" inside the config file
(same format as ~/.docker/config.json), never in shell history.`

export const LOGOUT_USAGE = `Usage: openmmcli auth logout <registry>

Remove saved credentials for a registry from the config file.

Arguments:
  <registry>             Registry host[:port] (e.g. localhost:5000)
  -h, --help             Show this help message`

interface RunOpts {
  configPath?: string
}

/** Core login: write auths[registry] = { ...existing, username, auth }. */
export async function runLogin(
  registry: string,
  username: string,
  password: string,
  opts?: RunOpts,
): Promise<void> {
  const normalized = normalizeRegistry(registry)
  if (!isValidRegistry(registry)) {
    throw new Error(
      `"${registry}" is not a registry host (expected e.g. localhost:5000 or registry.example.com)`,
    )
  }

  const config = loadConfig(opts?.configPath)
  if (config.auths === undefined) {
    config.auths = {}
  }
  const auths = config.auths
  const existing = auths[normalized] ?? {}
  auths[normalized] = { ...existing, username, auth: encodeAuth(username, password) }
  saveConfig(config, opts?.configPath)
  console.log(`Login succeeded (${normalized})`)
}

/** Core logout: remove the registry entry entirely. Returns false if absent. */
export async function runLogout(registry: string, opts?: RunOpts): Promise<boolean> {
  const normalized = normalizeRegistry(registry)
  if (!isValidRegistry(registry)) {
    throw new Error(
      `"${registry}" is not a registry host (expected e.g. localhost:5000 or registry.example.com)`,
    )
  }

  const config = loadConfig(opts?.configPath)
  if (config.auths?.[normalized] === undefined) {
    return false
  }
  delete config.auths[normalized]
  saveConfig(config, opts?.configPath)
  console.log(`Removed login credentials for ${normalized}`)
  return true
}

const LOGIN_STR_OPTS: Record<string, string> = {
  "--username": "username",
  "-u": "username",
  "--password": "password",
  "-p": "password",
}

const LOGIN_BOOL_FLAGS: Record<string, string> = {
  "--password-stdin": "passwordStdin",
}

export interface ParsedLoginArgs {
  registry: string | undefined
  username: string | undefined
  password: string | undefined
  passwordStdin: boolean
}

export function parseLoginArgs(args: string[]): ParsedLoginArgs {
  const parsed = parseCliArgs(args, { values: LOGIN_STR_OPTS, flags: LOGIN_BOOL_FLAGS })
  return {
    registry: parsed.positionals[0],
    username: singleValue(parsed.values["username"]),
    password: singleValue(parsed.values["password"]),
    passwordStdin: parsed.flags["passwordStdin"] === true,
  }
}

function singleValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined
}

function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true
}

export async function runLoginFromArgs(args: string[], opts?: RunOpts): Promise<void> {
  const parsed = parseLoginArgs(args)

  if (!parsed.registry) {
    throw new Error(
      "login requires a <registry> argument, e.g. openmmcli auth login localhost:5000",
    )
  }

  const username = parsed.username ?? (await promptUsername())
  const password = await resolveLoginPassword(parsed)

  await runLogin(parsed.registry, username, password, opts)
}

async function promptUsername(): Promise<string> {
  if (!isInteractive()) {
    throw new Error("login requires --username when not interactive")
  }
  const answer = await text({ message: "Username:" })
  if (isCancel(answer) || answer.trim() === "") {
    throw new Error("login cancelled")
  }
  return answer.trim()
}

async function resolveLoginPassword(parsed: ParsedLoginArgs): Promise<string> {
  if (parsed.passwordStdin) {
    const fromStdin = await resolvePassword(undefined, true)
    if (fromStdin === undefined) {
      throw new Error("no password received on stdin")
    }
    return fromStdin
  }
  if (parsed.password !== undefined) {
    return parsed.password
  }
  if (!isInteractive()) {
    throw new Error("login requires --password-stdin or --password when not interactive")
  }
  const answer = await passwordPrompt({ message: "Password:" })
  if (isCancel(answer)) {
    throw new Error("login cancelled")
  }
  return answer
}

const LOGOUT_STR_OPTS: Record<string, string> = {}

export function parseLogoutArgs(args: string[]): { registry: string | undefined } {
  const parsed = parseCliArgs(args, { values: LOGOUT_STR_OPTS })
  return { registry: parsed.positionals[0] }
}

export async function runLogoutFromArgs(args: string[], opts?: RunOpts): Promise<void> {
  const parsed = parseLogoutArgs(args)

  if (!parsed.registry) {
    throw new Error(
      "logout requires a <registry> argument, e.g. openmmcli auth logout localhost:5000",
    )
  }

  const removed = await runLogout(parsed.registry, opts)
  if (!removed) {
    throw new Error(`Not logged in to ${normalizeRegistry(parsed.registry)}`)
  }
}
