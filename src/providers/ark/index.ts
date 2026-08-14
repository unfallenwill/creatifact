import { loadCredentials, type ProviderCredentials } from "../core/config"
import { toUrlRef } from "../core/fileref"
import { requestJson } from "../core/http"
import {
  type EmbedApi,
  type ErrorCategory,
  type FileRef,
  type ImageGenerateApi,
  type JobHandle,
  type JobStatus,
  type Provider,
  ProviderError,
  type UnderstandApi,
  type Usage,
  type VideoGenerateApi,
} from "../core/types"
import { classifyArkError } from "./error-map"
import { ARK_MODELS } from "./models"

const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"

export interface ArkVideoOptions {
  resolution?: "720p" | "1080p"
  duration?: number
  ratio?: string
  watermark?: boolean
  seed?: number
  [key: string]: unknown
}

export interface ArkImageOptions {
  size?: string
  watermark?: boolean
  responseFormat?: "url" | "b64_json"
  [key: string]: unknown
}

export interface ArkChatOptions {
  temperature?: number
  maxTokens?: number
  [key: string]: unknown
}

export interface ArkEmbedOptions {
  [key: string]: unknown
}

export interface ArkProviderConfig {
  apiKey?: string
  baseUrl?: string
}

interface ArkTaskResponse {
  id: string
  status?: string
  error?: { code?: string; message?: string }
  content?: { video_url?: string }
  usage?: Record<string, unknown>
}

interface ArkImageResponse {
  data?: Array<{ url?: string; b64_json?: string }>
  usage?: Record<string, unknown>
}

interface ArkChatResponse {
  choices?: Array<{ message?: { content?: string } }>
  usage?: Record<string, unknown>
}

interface ArkEmbedResponse {
  data?: Array<{ embedding?: number[] }>
  usage?: Record<string, unknown>
}

function classifyJobFailure(code: string | undefined): ErrorCategory {
  if (!code) return "internal"
  if (/SensitiveContent|ContentFilter|审核|违规/i.test(code)) return "moderation"
  if (/QuotaExceeded|Arrears|AccountOverdue|Balance/i.test(code)) return "quota"
  if (/RateLimit|Throttling|ServerOverloaded/i.test(code)) return "rate"
  if (/Authentication|AccessDenied|AccessKey/i.test(code)) return "auth"
  return "internal"
}

function toUsage(native: Record<string, unknown> | undefined): Usage | undefined {
  return native ? { native } : undefined
}

export function createArkProvider(
  config: ArkProviderConfig = {},
  credentials: ProviderCredentials = loadCredentials(),
): Provider<["video.generate", "video.understand", "image.generate", "image.understand", "embed"]> {
  const apiKey = config.apiKey ?? credentials.arkApiKey
  if (!apiKey) {
    throw new ProviderError(
      "auth",
      "missing Ark API key: set ARK_API_KEY or providers.ark.apiKey in config",
    )
  }
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL
  const headers = { authorization: `Bearer ${apiKey}` }
  const request = <T>(path: string, opts: Parameters<typeof requestJson>[1] = {}) =>
    requestJson<T>(`${baseUrl}${path}`, {
      ...opts,
      headers: { ...headers, ...opts.headers },
      classifyError: opts.classifyError ?? classifyArkError,
    })

  function buildVideoContent(
    prompt: string,
    firstFrame: FileRef | undefined,
    lastFrame: FileRef | undefined,
  ): Array<Record<string, unknown>> {
    const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }]
    if (firstFrame) {
      content.push({
        type: "image_url",
        image_url: { url: toUrlRef(firstFrame).url },
        role: "first_frame",
      })
    }
    if (lastFrame) {
      content.push({
        type: "image_url",
        image_url: { url: toUrlRef(lastFrame).url },
        role: "last_frame",
      })
    }
    return content
  }

  function applyVideoOptions(body: Record<string, unknown>, options: ArkVideoOptions): void {
    const { resolution, duration, ratio, watermark, seed, ...rest } = options
    if (resolution) body["resolution"] = resolution
    if (duration) body["duration"] = duration
    if (ratio) body["ratio"] = ratio
    if (watermark !== undefined) body["watermark"] = watermark
    if (seed !== undefined) body["seed"] = seed
    Object.assign(body, rest)
  }

  const videoGenerate: VideoGenerateApi<ArkVideoOptions> = {
    async submit(req) {
      const content = buildVideoContent(req.prompt, req.firstFrame, req.lastFrame)
      const body: Record<string, unknown> = { model: req.model, content }
      if (req.options) {
        applyVideoOptions(body, req.options)
      }
      const resp = await request<ArkTaskResponse>("/contents/generations/tasks", {
        method: "POST",
        body,
      })
      return { providerId: "ark", id: resp.id }
    },

    async poll(handle: JobHandle): Promise<JobStatus> {
      const task = await request<ArkTaskResponse>(`/contents/generations/tasks/${handle.id}`)
      if (task.status === "queued") return { state: "pending" }
      if (task.status === "running") return { state: "running" }
      if (task.status === "failed" || task.status === "cancelled" || task.status === "expired") {
        return {
          state: "failed",
          error: {
            category: classifyJobFailure(task.error?.code),
            raw: task.error ?? { status: task.status },
          },
        }
      }
      if (task.status === "succeeded" || task.content?.video_url) {
        return {
          state: "done",
          artifacts: [
            {
              url: task.content?.video_url,
              mimeType: "video/mp4",
              expiresAt: undefined,
            },
          ],
          usage: toUsage(task.usage),
        }
      }
      return { state: "pending" }
    },
  }

  const imageGenerate: ImageGenerateApi<ArkImageOptions> = {
    async create(req) {
      const body: Record<string, unknown> = {
        model: req.model,
        prompt: req.prompt,
        response_format: req.options?.responseFormat ?? "url",
      }
      if (req.image) body["image"] = toUrlRef(req.image).url
      if (req.options) {
        const { size, watermark, responseFormat, ...rest } = req.options
        if (size) body["size"] = size
        if (watermark !== undefined) body["watermark"] = watermark
        Object.assign(body, rest)
      }
      const resp = await request<ArkImageResponse>("/images/generations", {
        method: "POST",
        body,
      })
      return {
        artifacts: (resp.data ?? []).map((item) => ({
          url: item.url,
          base64: item.b64_json,
          mimeType: "image/png",
        })),
        usage: toUsage(resp.usage),
      }
    },
  }

  function toChatMessages(
    messages: Parameters<UnderstandApi<ArkChatOptions>["create"]>[0]["messages"],
    fileKind: "image_url" | "video_url",
  ) {
    return messages.map((msg) => ({
      role: msg.role,
      content:
        typeof msg.content === "string"
          ? msg.content
          : msg.content.map((part) =>
              typeof part === "string"
                ? { type: "text", text: part }
                : { type: fileKind, [fileKind]: { url: toUrlRef(part.file).url } },
            ),
    }))
  }

  function understandApi(fileKind: "image_url" | "video_url"): UnderstandApi<ArkChatOptions> {
    return {
      async create(req) {
        const resp = await request<ArkChatResponse>("/chat/completions", {
          method: "POST",
          body: {
            model: req.model,
            messages: toChatMessages(req.messages, fileKind),
            ...(req.options ?? {}),
          },
        })
        return {
          text: resp.choices?.[0]?.message?.content ?? "",
          usage: toUsage(resp.usage),
        }
      },
    }
  }

  const embed: EmbedApi<ArkEmbedOptions> = {
    async create(req) {
      // 文本 embeddings 无 dimensions 参数(仅 multimodal 端点有),options 透传兜底
      const resp = await request<ArkEmbedResponse>("/embeddings", {
        method: "POST",
        body: { model: req.model, input: req.inputs, ...(req.options ?? {}) },
      })
      const vectors = (resp.data ?? []).map((item) => item.embedding ?? [])
      return {
        vectors,
        dimensions: vectors[0]?.length,
        usage: toUsage(resp.usage),
      }
    },
  }

  return {
    id: "ark",
    capabilities: [
      "video.generate",
      "video.understand",
      "image.generate",
      "image.understand",
      "embed",
    ],
    models: ARK_MODELS,
    videoGenerate,
    videoUnderstand: understandApi("video_url"),
    imageGenerate,
    imageUnderstand: understandApi("image_url"),
    embed,
  }
}
