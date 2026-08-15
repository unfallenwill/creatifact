import { loadConfig } from "../config"
import { type ArkProviderConfig, createArkProvider } from "./ark"
import type { Env, Provider } from "./core/types"
import { createKlingProvider, type KlingProviderConfig } from "./kling"
import { createMiniMaxProvider, type MiniMaxProviderConfig } from "./minimax"
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
export {
  type Artifact,
  type Capability,
  capabilitiesOf,
  type EmbedApi,
  type EmbedRequest,
  type EmbedResult,
  type Env,
  type ErrorCategory,
  type FileRef,
  type ImageGenerateApi,
  type ImageGenerateRequest,
  type ImageGenerateResult,
  type JobHandle,
  type JobStatus,
  type ModelSupport,
  type Provider,
  ProviderError,
  type UnderstandApi,
  type UnderstandMessage,
  type UnderstandRequest,
  type UnderstandResult,
  type Usage,
  type VerifiedModel,
  type VideoGenerateApi,
  type VideoGenerateRequest,
} from "./core/types"
export type { KlingImageOptions, KlingProviderConfig, KlingVideoOptions } from "./kling"
export { createKlingProvider } from "./kling"
export type {
  MiniMaxImageOptions,
  MiniMaxProviderConfig,
  MiniMaxSubjectReference,
  MiniMaxVideoOptions,
} from "./minimax"
export { createMiniMaxProvider } from "./minimax"
export type { ZhipuImageOptions, ZhipuProviderConfig, ZhipuVideoOptions } from "./zhipu"
export { createZhipuProvider } from "./zhipu"

type ProviderFactory = (settings: Record<string, unknown>, env: Env) => Provider

// Adding a new provider = one directory + one line here. Nothing in core
// knows provider ids, env names, or credential shapes.
const FACTORIES: Record<string, ProviderFactory> = {
  ark: (s, env) => createArkProvider(s as ArkProviderConfig, env),
  kling: (s, env) => createKlingProvider(s as KlingProviderConfig, env),
  minimax: (s, env) => createMiniMaxProvider(s as MiniMaxProviderConfig, env),
  zhipu: (s, env) => createZhipuProvider(s as ZhipuProviderConfig, env),
}

export interface CreateProviderOptions {
  /** Config file path (defaults to ~/.openmmcli/config.json or OPENMMCLI_CONFIG_DIR). */
  configPath?: string
  /** Explicit settings that override the config file's providers.<id> section. */
  settings?: Record<string, unknown>
}

export function listProviderIds(): string[] {
  return Object.keys(FACTORIES)
}

/**
 * Instantiate a provider by id. Reads the config file once and merges:
 *   providers.<id> section ← config file
 *   settings argument      ← explicit override
 * Credential env vars (e.g. ARK_API_KEY) are consulted inside each provider.
 */
export function createProvider(
  id: string,
  opts: CreateProviderOptions = {},
  env: Env = process.env,
): Provider {
  const factory = FACTORIES[id]
  if (!factory) {
    throw new Error(`unknown provider '${id}' (available: ${listProviderIds().join(", ")})`)
  }
  const config = loadConfig(opts.configPath)
  const section = config.providers?.[id]
  const settings = { ...(section ?? {}), ...opts.settings }
  return factory(settings, env)
}
