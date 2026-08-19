import { type CreatifactConfig, loadConfig } from "../config"
import { CliError } from "../errors"
import { type ArkProviderConfig, createArkProvider } from "./ark"
import { expandEnvRefs } from "./core/modelRegistry"
import type { Env, Provider } from "./core/types"
import { ProviderError } from "./core/types"
import { createKlingProvider, type KlingProviderConfig } from "./kling"
import { createMiniMaxProvider, type MiniMaxProviderConfig } from "./minimax"
import {
  assertPluginProvider,
  loadProviderFactory,
  PluginError,
  type ProviderFactory,
} from "./plugins"
import { createZhipuProvider, type ZhipuProviderConfig } from "./zhipu"

export type {
  ArkChatOptions,
  ArkEmbedOptions,
  ArkImageOptions,
  ArkProviderConfig,
  ArkVideoOptions,
} from "./ark"
export { createArkProvider } from "./ark"
export { isBase64Ref, isLocalPathRef, isUrlRef, MAX_INLINE_BYTES, toUrlRef } from "./core/fileref"
export type { ClassifyError, JsonClient, JsonClientConfig } from "./core/http"
export { createJsonClient, defaultClassifyError, requestJson } from "./core/http"
export type { PollOptions } from "./core/job"
export { JobTimeoutError, pollUntil } from "./core/job"
export type { ModelDeclaration } from "./core/modelRegistry"
export { expandEnvRefs, mergeModelDeclarations } from "./core/modelRegistry"
export {
  type Artifact,
  type CallContext,
  type Capability,
  capabilitiesOf,
  type EmbedApi,
  type EmbedRequest,
  type EmbedResult,
  type Env,
  type ErrorCategory,
  type FileRef,
  guardHandle,
  type ImageGenerateApi,
  type ImageGenerateRequest,
  type ImageGenerateResult,
  type JobHandle,
  type JobStatus,
  type ModelSupport,
  type Provider,
  ProviderError,
  type TextGenerateApi,
  type TextGenerateRequest,
  type TextGenerateResult,
  type UnderstandApi,
  type UnderstandMessage,
  type UnderstandRequest,
  type UnderstandResult,
  type Usage,
  type VerifiedModel,
  type VideoGenerateApi,
  type VideoGenerateRequest,
} from "./core/types"
export { guardFrameSupport } from "./core/validate"
export type { KlingImageOptions, KlingProviderConfig, KlingVideoOptions } from "./kling"
export { createKlingProvider } from "./kling"
export type {
  MiniMaxImageOptions,
  MiniMaxProviderConfig,
  MiniMaxSubjectReference,
  MiniMaxVideoOptions,
} from "./minimax"
export { createMiniMaxProvider } from "./minimax"
export type { PluginError, ProviderFactory, ProviderPluginModule } from "./plugins"
export { assertPluginProvider, loadProviderFactory } from "./plugins"
export type {
  ZhipuChatOptions,
  ZhipuImageOptions,
  ZhipuProviderConfig,
  ZhipuVideoOptions,
} from "./zhipu"
export { createZhipuProvider } from "./zhipu"

// Adding a new provider = one directory + one line here. Nothing in core
// knows provider ids, env names, or credential shapes. Third-party providers
// never touch this table — they are declared via providers.<id>.module in the
// config and loaded at runtime by ./plugins.
const FACTORIES: Record<string, ProviderFactory> = {
  ark: (s, env) => createArkProvider(s as ArkProviderConfig, env),
  kling: (s, env) => createKlingProvider(s as KlingProviderConfig, env),
  minimax: (s, env) => createMiniMaxProvider(s as MiniMaxProviderConfig, env),
  zhipu: (s, env) => createZhipuProvider(s as ZhipuProviderConfig, env),
}

export interface CreateProviderOptions {
  /** Config file path (defaults to ~/.creatifact/config.json or CREATIFACT_CONFIG_DIR). */
  configPath?: string
  /** Explicit settings that override the config file's providers.<id> section. */
  settings?: Record<string, unknown>
  /** Base directory for relative plugin module paths (default: process.cwd()). */
  cwd?: string
}

export function listProviderIds(): string[] {
  return Object.keys(FACTORIES)
}

function configuredPluginIds(config: CreatifactConfig): string[] {
  return Object.entries(config.providers ?? {})
    .filter(([, section]) => typeof section?.["module"] === "string" && section["module"] !== "")
    .map(([id]) => id)
}

/** Built-in ids plus every config section that declares a plugin module. */
export function listConfiguredProviderIds(opts: { configPath?: string } = {}): string[] {
  return [
    ...new Set([...Object.keys(FACTORIES), ...configuredPluginIds(loadConfig(opts.configPath))]),
  ]
}

const LISTING_PLACEHOLDER_KEY = "creatifact-models-listing"

export interface ProviderCatalog {
  provider: Provider
  /** Present when construction succeeded only with placeholder credentials. */
  listingOnly?: string
}

/**
 * List a provider's model catalog without requiring credentials. Model
 * registries are static (code + config declarations); API keys are only
 * consumed at request time, so an auth failure at construction is retried
 * with placeholder credentials — discovery must never be gated on secrets.
 */
export async function listProviderCatalog(
  id: string,
  opts: CreateProviderOptions = {},
  env: Env = process.env,
): Promise<ProviderCatalog> {
  try {
    return { provider: await createProvider(id, opts, env) }
  } catch (e) {
    if (e instanceof ProviderError && e.category === "auth") {
      const placeholder = {
        ...opts.settings,
        apiKey: LISTING_PLACEHOLDER_KEY,
        accessKey: LISTING_PLACEHOLDER_KEY,
        secretKey: LISTING_PLACEHOLDER_KEY,
      }
      const provider = await createProvider(id, { ...opts, settings: placeholder }, env)
      return { provider, listingOnly: "no credentials configured (listing only)" }
    }
    throw e
  }
}

/**
 * Instantiate a provider by id. Reads the config file once and merges:
 *   providers.<id> section ← config file
 *   settings argument      ← explicit override
 * A non-empty `module` string in the merged settings routes to a third-party
 * plugin (dynamic import); the `module` key itself is stripped before the
 * factory is called. Credential env vars (e.g. ARK_API_KEY) are consulted
 * inside each provider.
 */
export async function createProvider(
  id: string,
  opts: CreateProviderOptions = {},
  env: Env = process.env,
): Promise<Provider> {
  const config = loadConfig(opts.configPath)
  const merged: Record<string, unknown> = { ...(config.providers?.[id] ?? {}), ...opts.settings }
  // User model declarations live at config.models.<id> (top-level section);
  // explicit settings.models (programmatic) wins over the config file.
  if (merged["models"] === undefined && config.models?.[id] !== undefined) {
    merged["models"] = config.models[id]
  }
  // ${VAR} refs (e.g. apiKey: "${MINIMAX_API_KEY}") resolve from env at
  // consumption time; the config file on disk keeps the literal reference.
  const expanded = expandEnvRefs(merged, env) as Record<string, unknown>
  const module =
    typeof expanded["module"] === "string" && expanded["module"] !== ""
      ? expanded["module"]
      : undefined
  const builtin = FACTORIES[id]
  if (module) {
    if (builtin) {
      throw new PluginError(
        id,
        `'${id}' is a built-in provider; remove providers.${id}.module or pick another id`,
      )
    }
    const settings = { ...expanded }
    delete settings["module"]
    const factory = await loadProviderFactory(id, module, opts.cwd ?? process.cwd())
    const provider = factory(settings, env)
    assertPluginProvider(id, provider)
    return provider
  }
  if (!builtin) {
    const available = [...new Set([...Object.keys(FACTORIES), ...configuredPluginIds(config)])]
    throw new CliError("E_USAGE", `unknown provider '${id}' (available: ${available.join(", ")})`)
  }
  return builtin(expanded, env)
}

/** Identity helper for plugin authors: typed settings + compile-time contract checking. */
export function defineProvider<C extends Record<string, unknown>>(
  factory: (settings: C, env: Env) => Provider,
): ProviderFactory {
  return factory as unknown as ProviderFactory
}
