import { createRequire } from "node:module"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { capabilitiesOf, type Env, METHOD_CAPABILITIES, type Provider } from "./core/types"

/** A provider factory: turns a settings bag + env into a Provider. */
export type ProviderFactory = (settings: Record<string, unknown>, env: Env) => Provider

/** Module shape a plugin must provide: a default-exported provider factory. */
export interface ProviderPluginModule {
  default: ProviderFactory
}

/** Loader/contract failures for third-party provider modules. Not retryable. */
export class PluginError extends Error {
  readonly providerId: string

  constructor(providerId: string, message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = "PluginError"
    this.providerId = providerId
    if (options?.cause !== undefined) {
      ;(this as { cause?: unknown }).cause = options.cause
    }
  }
}

const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/
const NOT_FOUND_CODES = new Set([
  "ERR_MODULE_NOT_FOUND",
  "MODULE_NOT_FOUND",
  "ERR_PACKAGE_PATH_NOT_EXPORTED",
  "ERR_UNSUPPORTED_DIR_IMPORT",
])

function expandHome(specifier: string): string {
  if (specifier === "~") return homedir()
  if (specifier.startsWith("~/")) return join(homedir(), specifier.slice(2))
  return specifier
}

function isPathSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    isAbsolute(specifier) ||
    WINDOWS_ABSOLUTE.test(specifier)
  )
}

async function importPluginModule(
  id: string,
  specifier: string,
  cwd: string,
): Promise<ProviderPluginModule> {
  const expanded = expandHome(specifier)
  if (isPathSpecifier(expanded)) {
    // Paths resolve against the caller's cwd: inside the bundle, a bare
    // import() would resolve against dist/providers/ instead.
    const url = pathToFileURL(resolve(cwd, expanded)).href
    try {
      return (await import(/* @vite-ignore */ url)) as ProviderPluginModule
    } catch (e) {
      throw new PluginError(
        id,
        `cannot load provider module '${specifier}': ${(e as Error).message}`,
        { cause: e },
      )
    }
  }
  // Bare specifier: Node resolves it from openmmcli's own module tree first
  // (same-project or both-global installs), then falls back to the user's cwd
  // (global openmmcli + project-local plugin).
  try {
    return (await import(/* @vite-ignore */ specifier)) as ProviderPluginModule
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? ""
    if (!NOT_FOUND_CODES.has(code)) {
      throw new PluginError(
        id,
        `provider module '${specifier}' failed to load: ${(e as Error).message}`,
        { cause: e },
      )
    }
    let resolved: string
    try {
      resolved = createRequire(resolve(cwd, "package.json")).resolve(specifier)
    } catch (resolveErr) {
      throw new PluginError(
        id,
        `cannot resolve provider module '${specifier}' (tried openmmcli's module tree and '${cwd}'): ${(resolveErr as Error).message}`,
        { cause: resolveErr },
      )
    }
    return (await import(/* @vite-ignore */ pathToFileURL(resolved).href)) as ProviderPluginModule
  }
}

/** Resolve + import a plugin module and check the default export's shape. */
export async function loadProviderFactory(
  id: string,
  specifier: string,
  cwd: string,
): Promise<ProviderFactory> {
  const factory = (await importPluginModule(id, specifier, cwd)).default
  if (typeof factory !== "function") {
    throw new PluginError(
      id,
      `provider module '${specifier}' must default-export a (settings, env) => Provider factory (got ${typeof factory})`,
    )
  }
  return factory
}

/** Runtime-check what a plugin factory returned (built-ins are typed already). */
export function assertPluginProvider(id: string, provider: Provider): void {
  if (typeof provider !== "object" || provider === null) {
    throw new PluginError(id, `provider factory must return an object (got ${typeof provider})`)
  }
  if (typeof provider.id !== "string" || provider.id === "") {
    throw new PluginError(id, "provider must have a non-empty string 'id'")
  }
  if (provider.id !== id) {
    throw new PluginError(
      id,
      `provider declares id '${provider.id}' but is configured as '${id}'; rename the config section or fix the factory`,
    )
  }
  if (!Array.isArray(provider.models)) {
    throw new PluginError(id, "provider must expose 'models' as an array")
  }
  for (const model of provider.models) {
    if (typeof model.id !== "string" || model.id === "") {
      throw new PluginError(id, "every entry in provider.models needs a non-empty string 'id'")
    }
  }
  const implemented = capabilitiesOf(provider)
  if (implemented.length === 0) {
    throw new PluginError(
      id,
      `provider implements none of the capability APIs (${METHOD_CAPABILITIES.map(([m]) => m).join(", ")})`,
    )
  }
  for (const [method] of METHOD_CAPABILITIES) {
    const value = provider[method]
    if (value !== undefined && typeof value !== "object") {
      throw new PluginError(
        id,
        `provider capability '${method}' must be an API object (got ${typeof value})`,
      )
    }
    const api = value as Record<string, unknown> | undefined
    if (api === undefined) continue
    for (const [name, fn] of Object.entries(api)) {
      if (fn !== undefined && typeof fn !== "function") {
        throw new PluginError(
          id,
          `provider capability '${method}' has non-function member '${name}' (got ${typeof fn})`,
        )
      }
    }
  }
}
