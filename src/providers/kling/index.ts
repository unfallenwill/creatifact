import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { loadCredentials, type ProviderCredentials } from "../core/config"
import { requestJson } from "../core/http"
import {
  type FileRef,
  type ImageGenerateApi,
  type JobHandle,
  type JobStatus,
  type Provider,
  ProviderError,
  type VideoGenerateApi,
} from "../core/types"
import { classifyKlingError } from "./error-map"
import { signKlingJwt } from "./jwt"
import { KLING_MODELS } from "./models"

const DEFAULT_BASE_URL = "https://api-beijing.klingai.com"
const RESULT_TTL_MS = 30 * 24 * 60 * 60 * 1000

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

// Kling 的 url 字段接受 http(s) URL 或裸 base64,不接受 data URI
function toKlingFileUrl(ref: FileRef): string {
  if ("url" in ref) return ref.url
  if ("base64" in ref) return ref.base64
  return readFileSync(ref.localPath).toString("base64")
}

function authHeaders(config: KlingProviderConfig, creds: ProviderCredentials) {
  const apiKey = config.apiKey ?? creds.klingApiKey
  if (apiKey) return { authorization: `Bearer ${apiKey}` }

  const accessKey = config.accessKey ?? creds.klingAccessKey
  const secretKey = config.secretKey ?? creds.klingSecretKey
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
            expiresAt: new Date(Date.now() + RESULT_TTL_MS).toISOString(),
          })),
      }
    default:
      return { state: "pending" }
  }
}

export function createKlingProvider(
  config: KlingProviderConfig = {},
  credentials: ProviderCredentials = loadCredentials(),
): Provider<["video.generate", "image.generate"]> {
  authHeaders(config, credentials)
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL

  const request = <T>(path: string, opts: Parameters<typeof requestJson>[1] = {}) => {
    const headers = authHeaders(config, credentials)
    return requestJson<KlingEnvelope<T>>(`${baseUrl}${path}`, {
      ...opts,
      headers: { ...headers, ...opts.headers },
      classifyError: opts.classifyError ?? classifyKlingError,
      // Kling 查询接口有自身限流,重试留给 pollUntil 的间隔控制
      retries: 1,
    })
  }

  function unwrap<T>(envelope: KlingEnvelope<T>): T {
    if (typeof envelope.code === "number" && envelope.code !== 0) {
      throw new ProviderError("internal", envelope.message ?? `code ${envelope.code}`, envelope)
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
    async submit(req) {
      if (req.lastFrame) {
        throw new ProviderError(
          "internal",
          "Kling new API has no last frame input; 3.0 Turbo supports first frame only",
        )
      }
      const externalId = randomUUID()
      const contents: Array<Record<string, unknown>> = [{ type: "prompt", text: req.prompt }]
      if (req.firstFrame) {
        contents.push({ type: "first_frame", url: toKlingFileUrl(req.firstFrame) })
      }

      const path = req.firstFrame ? `/image-to-video/${req.model}` : `/text-to-video/${req.model}`
      const envelope = await request<KlingNewTask>(path, {
        method: "POST",
        body: buildVideoBody(req.options, contents, externalId),
      })
      unwrap(envelope)
      return { providerId: "kling", id: externalId }
    },

    async poll(handle: JobHandle): Promise<JobStatus> {
      const envelope = await request<KlingNewTask[]>(`/tasks?external_task_ids=${handle.id}`)
      const data = unwrap<KlingNewTask[]>(envelope)
      const task = data?.[0]
      if (!task) return { state: "pending" }
      return videoStatusOf(task)
    },
  }

  function imageStatusOf(task: KlingImageTask): {
    done: boolean
    failed: boolean
    message: string
    urls: Array<{ url: string | undefined; watermark: boolean | undefined }>
  } {
    const status = task.task_status ?? task.status
    const failed = status === "failed"
    const done = status === "succeed" || status === "succeeded"
    const legacyImages = (task.task_result?.images ?? []).map((img) => ({
      url: img.url,
      watermark: img.watermark_url ? true : undefined,
    }))
    const newImages = (task.outputs ?? [])
      .filter((o) => (o.type ?? "image") === "image")
      .map((o) => ({ url: o.url, watermark: o.watermark_url ? true : undefined }))
    return {
      done,
      failed,
      message: task.task_status_msg ?? task.message ?? "",
      urls: legacyImages.length > 0 ? legacyImages : newImages,
    }
  }

  function buildImageBody(
    req: Parameters<ImageGenerateApi<KlingImageOptions>["create"]>[0],
    externalId: string,
  ): Record<string, unknown> {
    const { watermark, ...rest } = req.options ?? {}
    const body: Record<string, unknown> = {
      model_name: req.model,
      prompt: req.prompt,
      external_task_id: externalId,
      ...rest,
    }
    if (req.image) {
      body["image"] = toKlingFileUrl(req.image)
    }
    if (watermark !== undefined) {
      body["watermark_info"] = { enabled: watermark }
    }
    return body
  }

  const imageGenerate: ImageGenerateApi<KlingImageOptions> = {
    async create(req) {
      const externalId = randomUUID()
      // Kling 图片生成端点是旧版任务制,sync 接口内部轮询收口
      const deadline = Date.now() + 300_000
      await request<KlingImageTask>("/v1/images/generations", {
        method: "POST",
        body: buildImageBody(req, externalId),
      })
      for (;;) {
        const envelope = await request<KlingImageTask>(`/v1/images/generations/${externalId}`)
        const task = unwrap<KlingImageTask>(envelope)
        const status = imageStatusOf(task)
        if (status.done) {
          return {
            artifacts: status.urls.map((img) => ({ url: img.url, mimeType: "image/png" })),
          }
        }
        if (status.failed) {
          const category = classifyKlingError(200, { error: { message: status.message } })
          throw new ProviderError(
            category ?? "internal",
            status.message || "image generation failed",
          )
        }
        if (Date.now() >= deadline) {
          throw new ProviderError("internal", `image generation timed out (task ${externalId})`)
        }
        await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs ?? 5000))
      }
    },
  }

  return {
    id: "kling",
    capabilities: ["video.generate", "image.generate"],
    models: KLING_MODELS,
    videoGenerate,
    imageGenerate,
  }
}
