import { randomUUID } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import { MAX_INLINE_BYTES } from "../core/fileref"
import { createJsonClient, type JsonClient, SLOW_POST_TIMEOUT_MS } from "../core/http"
import { pollToArtifacts } from "../core/job"
import { mergeModelDeclarations } from "../core/modelRegistry"
import {
  type Env,
  type FileRef,
  guardHandle,
  type ImageGenerateApi,
  type ImageGenerateResult,
  type JobHandle,
  type JobStatus,
  type Provider,
  ProviderError,
  type VideoGenerateApi,
} from "../core/types"
import { guardFrameSupport } from "../core/validate"
import { classifyKlingError } from "./error-map"
import { signKlingJwt } from "./jwt"
import { KLING_DEFAULT_MODELS, KLING_MODELS } from "./models"

const DEFAULT_BASE_URL = "https://api-beijing.klingai.com"
const IMAGE_POLL_TIMEOUT_MS = 300_000
/** Submits carry inline base64 frames (up to 50MB) — the 30s default is too tight. */

export interface KlingVideoOptions {
  duration?: number
  aspectRatio?: string
  resolution?: "720p" | "1080p"
  watermark?: boolean
  [key: string]: unknown
}

export interface KlingImageOptions {
  watermark?: boolean
  [key: string]: unknown
}

export interface KlingProviderConfig {
  apiKey?: string
  accessKey?: string
  secretKey?: string
  baseUrl?: string
  pollIntervalMs?: number
  /** Image generation internal polling timeout (default 300s) */
  pollTimeoutMs?: number
  /** User model declarations from config.json's models.kling (appended; kling has no protocol modes). */
  models?: unknown
}

/** The concrete shape createKlingProvider returns. */
export type KlingProvider = Provider & {
  videoGenerate: VideoGenerateApi<KlingVideoOptions>
  imageGenerate: ImageGenerateApi<KlingImageOptions>
}

interface KlingEnvelope<T> {
  code?: number
  message?: string
  request_id?: string
  data?: T
}

interface KlingOutput {
  type?: string
  id?: string
  url?: string
  watermark_url?: string
}

interface KlingNewTask {
  id?: string
  status?: string
  message?: string
  outputs?: KlingOutput[]
}

interface KlingImageTask {
  task_id?: string
  task_status?: string
  task_status_msg?: string
  status?: string
  message?: string
  outputs?: KlingOutput[]
  task_result?: {
    images?: Array<{ index?: number; url?: string; watermark_url?: string }>
  }
}

// Kling's url field accepts http(s) URLs or bare base64, not data URIs
async function toKlingFileUrl(ref: FileRef): Promise<string> {
  if ("url" in ref) return ref.url
  if ("base64" in ref) return ref.base64
  const { size } = await stat(ref.localPath)
  if (size > MAX_INLINE_BYTES) {
    throw new ProviderError(
      "invalid",
      `file too large to inline (${size} bytes > ${MAX_INLINE_BYTES}): ${ref.localPath}. ` +
        "Upload it and pass a { url } FileRef instead",
    )
  }
  const data = await readFile(ref.localPath)
  return data.toString("base64")
}

function authHeaders(config: KlingProviderConfig, env: Env) {
  const apiKey = config.apiKey ?? env["KLING_API_KEY"]
  if (apiKey) return { authorization: `Bearer ${apiKey}` }

  const accessKey = config.accessKey ?? env["KLING_ACCESS_KEY"]
  const secretKey = config.secretKey ?? env["KLING_SECRET_KEY"]
  if (accessKey && secretKey) {
    return {
      authorization: `Bearer ${signKlingJwt(accessKey, secretKey, Math.floor(Date.now() / 1000))}`,
    }
  }

  throw new ProviderError(
    "auth",
    "missing Kling credentials: set KLING_API_KEY or KLING_ACCESS_KEY + KLING_SECRET_KEY, or providers.kling in config",
  )
}

function videoStatusOf(task: KlingNewTask): JobStatus {
  switch (task.status) {
    case "submitted":
      return { state: "pending" }
    case "processing":
      return { state: "running" }
    case "failed":
      return {
        state: "failed",
        error: {
          category:
            classifyKlingError(200, { error: { message: task.message ?? "" } }) ?? "internal",
          raw: task.message,
        },
      }
    case "succeeded":
      return {
        state: "done",
        artifacts: (task.outputs ?? [])
          .filter((o) => o.type === "video")
          .map((o) => ({
            url: o.url,
            watermark: o.watermark_url ? true : undefined,
            mimeType: "video/mp4",
          })),
      }
    default:
      return { state: "pending" }
  }
}

function imageTaskToStatus(task: KlingImageTask): JobStatus {
  const status = task.task_status ?? task.status
  if (status === "failed") {
    const message = task.task_status_msg ?? task.message ?? ""
    return {
      state: "failed",
      error: {
        category: classifyKlingError(200, { error: { message } }) ?? "internal",
        raw: message,
      },
    }
  }
  if (status === "succeed" || status === "succeeded") {
    const legacyImages = (task.task_result?.images ?? []).map((img) => ({
      url: img.url,
      watermark: img.watermark_url ? true : undefined,
    }))
    const newImages = (task.outputs ?? [])
      .filter((o) => (o.type ?? "image") === "image")
      .map((o) => ({ url: o.url, watermark: o.watermark_url ? true : undefined }))
    const urls = legacyImages.length > 0 ? legacyImages : newImages
    return {
      state: "done",
      artifacts: urls.map((img) => ({
        url: img.url,
        watermark: img.watermark,
        mimeType: "image/png",
      })),
    }
  }
  return { state: "pending" }
}

export function createKlingProvider(
  config: KlingProviderConfig = {},
  env: Env = process.env,
): KlingProvider {
  authHeaders(config, env)
  // Built-in verified list + user declarations (config.json models.kling):
  // kling dispatches on request shape (firstFrame presence), no protocol modes.
  const { models: mergedModels } = mergeModelDeclarations("kling", KLING_MODELS, config.models)
  const client: JsonClient = createJsonClient({
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    headers: () => authHeaders(config, env),
    classifyError: classifyKlingError,
    // Kling's query endpoint rate-limits on its own; one retry uniformly; submit idempotency is guaranteed by external_task_id
    retries: 1,
  })

  /** Kling reports business errors via an envelope code inside HTTP 200; classify instead of defaulting to internal. */
  function unwrap<T>(envelope: KlingEnvelope<T>): T {
    if (typeof envelope.code === "number" && envelope.code !== 0) {
      const category = classifyKlingError(200, envelope) ?? "internal"
      throw new ProviderError(category, envelope.message ?? `code ${envelope.code}`, envelope)
    }
    return envelope.data as T
  }

  function buildVideoBody(
    options: KlingVideoOptions | undefined,
    contents: Array<Record<string, unknown>>,
    externalId: string,
  ): Record<string, unknown> {
    const { duration, aspectRatio, resolution, watermark, ...rest } = options ?? {}
    const settings: Record<string, unknown> = rest
    if (duration !== undefined) settings["duration"] = duration
    if (aspectRatio) settings["aspect_ratio"] = aspectRatio
    if (resolution) settings["resolution"] = resolution

    const opts: Record<string, unknown> = { external_task_id: externalId }
    if (watermark !== undefined) opts["watermark_info"] = { enabled: watermark }
    return { contents, settings, options: opts }
  }

  const videoGenerate: VideoGenerateApi<KlingVideoOptions> = {
    async submit(req, ctx) {
      // API-level fact: the new endpoint takes no last-frame param (for all models, unknown ids included)
      if (req.lastFrame) {
        throw new ProviderError(
          "invalid",
          "Kling new API has no last frame input; 3.0 Turbo supports first frame only",
        )
      }
      guardFrameSupport(mergedModels, req)
      const externalId = randomUUID()
      const contents: Array<Record<string, unknown>> = [{ type: "prompt", text: req.prompt }]
      if (req.firstFrame) {
        contents.push({ type: "first_frame", url: await toKlingFileUrl(req.firstFrame) })
      }

      const path = req.firstFrame ? `/image-to-video/${req.model}` : `/text-to-video/${req.model}`
      const envelope = await client.post<KlingEnvelope<KlingNewTask>>(
        path,
        buildVideoBody(req.options, contents, externalId),
        { timeoutMs: SLOW_POST_TIMEOUT_MS, signal: ctx?.signal },
      )
      unwrap(envelope)
      return { providerId: "kling", id: externalId }
    },

    async poll(handle: JobHandle, ctx): Promise<JobStatus> {
      guardHandle("kling", handle)
      const envelope = await client.get<KlingEnvelope<KlingNewTask[]>>(
        `/tasks?external_task_ids=${handle.id}`,
        { signal: ctx?.signal },
      )
      const task = unwrap<KlingNewTask[]>(envelope)?.[0]
      if (!task) return { state: "pending" }
      return videoStatusOf(task)
    },
  }

  const imageGenerate: ImageGenerateApi<KlingImageOptions> = {
    async create(req, ctx): Promise<ImageGenerateResult> {
      const externalId = randomUUID()
      const { watermark, ...rest } = req.options ?? {}
      const body: Record<string, unknown> = {
        model_name: req.model,
        prompt: req.prompt,
        external_task_id: externalId,
        ...rest,
      }
      if (req.image) {
        body["image"] = await toKlingFileUrl(req.image)
      }
      if (watermark !== undefined) {
        body["watermark_info"] = { enabled: watermark }
      }
      // Kling's image generation endpoint is the legacy task-based one; the sync API polls internally (reusing pollUntil)
      const submitted = await client.post<KlingEnvelope<KlingImageTask>>(
        "/v1/images/generations",
        body,
        { timeoutMs: SLOW_POST_TIMEOUT_MS },
      )
      // Envelope business errors (insufficient balance / invalid params / ...) throw here immediately,
      // otherwise we would poll a nonexistent task until the 300s timeout
      unwrap(submitted)

      // The polling endpoint /v1/images/generations/{id} can resume timed-out tasks manually
      return pollToArtifacts(
        async () => {
          const envelope = await client.get<KlingEnvelope<KlingImageTask>>(
            `/v1/images/generations/${externalId}`,
          )
          return imageTaskToStatus(unwrap(envelope))
        },
        { providerId: "kling", id: externalId },
        {
          intervalMs: config.pollIntervalMs ?? 5000,
          timeoutMs: config.pollTimeoutMs ?? IMAGE_POLL_TIMEOUT_MS,
          signal: ctx?.signal,
          label: "image generation",
        },
      )
    },
  }

  return {
    id: "kling",
    models: mergedModels,
    defaultModels: KLING_DEFAULT_MODELS,
    videoGenerate,
    imageGenerate,
  }
}
