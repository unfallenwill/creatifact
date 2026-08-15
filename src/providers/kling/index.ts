import { randomUUID } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import { createJsonClient, type JsonClient } from "../core/http"
import { JobTimeoutError, pollUntil } from "../core/job"
import {
  type Env,
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
const IMAGE_POLL_TIMEOUT_MS = 300_000

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

// Kling 的 url 字段接受 http(s) URL 或裸 base64,不接受 data URI
async function toKlingFileUrl(ref: FileRef): Promise<string> {
  if ("url" in ref) return ref.url
  if ("base64" in ref) return ref.base64
  const { size } = await stat(ref.localPath)
  const limit = 50 * 1024 * 1024
  if (size > limit) {
    throw new ProviderError(
      "invalid",
      `file too large to inline (${size} bytes): ${ref.localPath}. Pass a { url } FileRef instead`,
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
  const client: JsonClient = createJsonClient({
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    headers: () => authHeaders(config, env),
    classifyError: classifyKlingError,
    // Kling 查询接口有自身限流,统一 1 次重试;提交幂等性由 external_task_id 保证
    retries: 1,
  })

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
          "invalid",
          "Kling new API has no last frame input; 3.0 Turbo supports first frame only",
        )
      }
      const externalId = randomUUID()
      const contents: Array<Record<string, unknown>> = [{ type: "prompt", text: req.prompt }]
      if (req.firstFrame) {
        contents.push({ type: "first_frame", url: await toKlingFileUrl(req.firstFrame) })
      }

      const path = req.firstFrame ? `/image-to-video/${req.model}` : `/text-to-video/${req.model}`
      const envelope = await client.post<KlingEnvelope<KlingNewTask>>(
        path,
        buildVideoBody(req.options, contents, externalId),
      )
      unwrap(envelope)
      return { providerId: "kling", id: externalId }
    },

    async poll(handle: JobHandle): Promise<JobStatus> {
      if (handle.providerId !== "kling") {
        throw new ProviderError("invalid", `handle belongs to '${handle.providerId}', not 'kling'`)
      }
      const envelope = await client.get<KlingEnvelope<KlingNewTask[]>>(
        `/tasks?external_task_ids=${handle.id}`,
      )
      const task = unwrap<KlingNewTask[]>(envelope)?.[0]
      if (!task) return { state: "pending" }
      return videoStatusOf(task)
    },
  }

  const imageGenerate: ImageGenerateApi<KlingImageOptions> = {
    async create(req) {
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
      // Kling 图片生成端点是旧版任务制,sync 接口内部轮询收口(复用 pollUntil)
      await client.post<KlingEnvelope<KlingImageTask>>("/v1/images/generations", body)

      const final = await pollUntil(
        async () => {
          const envelope = await client.get<KlingEnvelope<KlingImageTask>>(
            `/v1/images/generations/${externalId}`,
          )
          return imageTaskToStatus(unwrap(envelope))
        },
        { providerId: "kling", id: externalId },
        {
          intervalMs: config.pollIntervalMs ?? 5000,
          timeoutMs: IMAGE_POLL_TIMEOUT_MS,
        },
      ).catch((e: unknown) => {
        if (e instanceof JobTimeoutError) {
          throw new ProviderError("internal", `image generation timed out (task ${externalId})`)
        }
        throw e
      })

      if (final.state === "done") return { artifacts: final.artifacts }
      // pollUntil only resolves on done/failed
      throw new ProviderError(
        final.error.category,
        (final.error.raw as string) || "image generation failed",
      )
    },
  }

  return {
    id: "kling",
    models: KLING_MODELS,
    videoGenerate,
    imageGenerate,
  }
}
