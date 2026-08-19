import { isCancel, password as passwordPrompt, text } from "@clack/prompts"

import { Command } from "commander"

import {
  encodeAuth,
  isValidRegistry,
  loadConfig,
  normalizeRegistry,
  type RegistryAuthEntry,
  saveConfig,
} from "./config"
import { ok, status } from "./format"
import { addGlobalOptions, configOpts, parseArgsWith, resolvePassword } from "./util"

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
  ok(`login succeeded (${normalized})`)
}

/** Core logout: drop credentials but keep the entry's insecure flag. Returns false if absent. */
export async function runLogout(registry: string, opts?: RunOpts): Promise<boolean> {
  const normalized = normalizeRegistry(registry)
  if (!isValidRegistry(registry)) {
    throw new Error(
      `"${registry}" is not a registry host (expected e.g. localhost:5000 or registry.example.com)`,
    )
  }

  const config = loadConfig(opts?.configPath)
  const entry = config.auths?.[normalized]
  if (entry === undefined) {
    return false
  }
  const auths = config.auths as Record<string, RegistryAuthEntry>
  if (entry.insecure === true) {
    auths[normalized] = { insecure: true }
  } else {
    delete auths[normalized]
  }
  saveConfig(config, opts?.configPath)
  status(`removed login credentials for ${normalized}`)
  return true
}

export interface LoginCommandOptions {
  username?: string
  password?: string
  passwordStdin?: boolean
  configDir?: string
}

export function buildLoginCommand(): Command {
  const cmd = new Command("login")
    .description("Save registry credentials to the creatifact config file")
    .argument("[registry]", "Registry host[:port] (e.g. localhost:5000, registry.example.com)")
    .option("-u, --username <user>", "Registry username (prompted if omitted and interactive)")
    .option("-p, --password <pw>", "Registry password (prefer --password-stdin)")
    .option("--password-stdin", "Read password from stdin")
  return addGlobalOptions(cmd)
}

export function loginArgsFromOptions(
  registry: string | undefined,
  o: LoginCommandOptions,
): ParsedLoginArgs {
  return {
    registry,
    username: o.username,
    password: o.password,
    passwordStdin: o.passwordStdin === true,
  }
}

export interface ParsedLoginArgs {
  registry: string | undefined
  username: string | undefined
  password: string | undefined
  passwordStdin: boolean
}

export function parseLoginArgs(args: string[]): ParsedLoginArgs {
  const { options, positionals } = parseArgsWith<LoginCommandOptions>(buildLoginCommand(), args)
  return loginArgsFromOptions(positionals[0], options)
}

function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true
}

export async function runLoginFromArgs(args: string[], opts?: RunOpts): Promise<void> {
  await runLoginFromParsed(parseLoginArgs(args), opts)
}

export async function runLoginFromParsed(parsed: ParsedLoginArgs, opts?: RunOpts): Promise<void> {
  if (!parsed.registry) {
    throw new Error(
      "login requires a <registry> argument, e.g. creatifact auth login localhost:5000",
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

export interface LogoutCommandOptions {
  configDir?: string
}

export function buildLogoutCommand(): Command {
  const cmd = new Command("logout")
    .description("Remove saved credentials for a registry from the config file")
    .argument("[registry]", "Registry host[:port] (e.g. localhost:5000)")
  return addGlobalOptions(cmd)
}

export function parseLogoutArgs(args: string[]): { registry: string | undefined } {
  const { positionals } = parseArgsWith(buildLogoutCommand(), args)
  return { registry: positionals[0] }
}

export async function runLogoutFromArgs(args: string[], opts?: RunOpts): Promise<void> {
  await runLogoutFromParsed(parseLogoutArgs(args), opts)
}

export async function runLogoutFromParsed(
  parsed: { registry: string | undefined },
  opts?: RunOpts,
): Promise<void> {
  if (!parsed.registry) {
    throw new Error(
      "logout requires a <registry> argument, e.g. creatifact auth logout localhost:5000",
    )
  }

  const removed = await runLogout(parsed.registry, opts)
  if (!removed) {
    throw new Error(`Not logged in to ${normalizeRegistry(parsed.registry)}`)
  }
}

export function buildAuthCommand(): Command {
  const auth = new Command("auth")
    .usage("<action>")
    .description("Manage registry credentials stored in the creatifact config file")
  addGlobalOptions(auth)
  auth.allowExcessArguments(true)

  auth.addCommand(
    buildLoginCommand().action(
      async (registry: string | undefined, opts: LoginCommandOptions, command: Command) => {
        await runLoginFromParsed(
          loginArgsFromOptions(registry, opts),
          configOpts(command, opts.configDir),
        )
      },
    ),
  )
  auth.addCommand(
    buildLogoutCommand().action(
      async (registry: string | undefined, opts: LogoutCommandOptions, command: Command) => {
        await runLogoutFromParsed({ registry }, configOpts(command, opts.configDir))
      },
    ),
  )

  auth.action((_opts, command) => {
    const action = command.args[0]
    if (action === undefined) {
      command.help()
      return
    }
    throw new Error(`unknown auth action '${action}' (expected login, logout)`)
  })
  return auth
}
