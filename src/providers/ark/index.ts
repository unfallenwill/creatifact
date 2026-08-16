import { toUrlRef } from "../core/fileref"
import { createJsonClient, type JsonClient, SLOW_POST_TIMEOUT_MS } from "../core/http"
import {
  type EmbedApi,
  type Env,
  type ErrorCategory,
  type FileRef,
  guardHandle,
  type ImageGenerateApi,
  type JobHandle,
  type JobStatus,
  type Provider,
  ProviderError,
  type UnderstandApi,
  type Usage,
  type VideoGenerateApi,
} from "../core/types"
import { guardFrameSupport } from "../core/validate"
import { classifyArkError } from "./error-map"
import { ARK_MODELS } from "./models"

const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"
/** 带内联帧(data URI 可达 50MB+)的提交与同步图像生成,30s 默认超时偏紧。 */

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

/** The concrete shape createArkProvider returns — every capability is present. */
export type ArkProvider = Provider & {
  videoGenerate: VideoGenerateApi<ArkVideoOptions>
  videoUnderstand: UnderstandApi<ArkChatOptions>
  imageGenerate: ImageGenerateApi<ArkImageOptions>
  imageUnderstand: UnderstandApi<ArkChatOptions>
  embed: EmbedApi<ArkEmbedOptions>
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
  return classifyArkError(200, code ? { error: { code } } : undefined) ?? "internal"
}

function toUsage(native: Record<string, unknown> | undefined): Usage | undefined {
  return native ? { native } : undefined
}

export function createArkProvider(
  config: ArkProviderConfig = {},
  env: Env = process.env,
): ArkProvider {
  const apiKey = config.apiKey ?? env["ARK_API_KEY"]
  if (!apiKey) {
    throw new ProviderError(
      "auth",
      "missing Ark API key: set ARK_API_KEY or providers.ark.apiKey in config",
    )
  }
  const client: JsonClient = createJsonClient({
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    headers: { authorization: `Bearer ${apiKey}` },
    classifyError: classifyArkError,
  })

  async function buildVideoContent(
    prompt: string,
    firstFrame: FileRef | undefined,
    lastFrame: FileRef | undefined,
  ): Promise<Array<Record<string, unknown>>> {
    const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }]
    if (firstFrame) {
      content.push({
        type: "image_url",
        image_url: { url: (await toUrlRef(firstFrame, "image/png")).url },
        role: "first_frame",
      })
    }
    if (lastFrame) {
      content.push({
        type: "image_url",
        image_url: { url: (await toUrlRef(lastFrame, "image/png")).url },
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
      guardFrameSupport(ARK_MODELS, req)
      const content = await buildVideoContent(req.prompt, req.firstFrame, req.lastFrame)
      const body: Record<string, unknown> = { model: req.model, content }
      if (req.options) {
        applyVideoOptions(body, req.options)
      }
      const resp = await client.post<ArkTaskResponse>("/contents/generations/tasks", body, {
        timeoutMs: SLOW_POST_TIMEOUT_MS,
      })
      return { providerId: "ark", id: resp.id }
    },

    async poll(handle: JobHandle): Promise<JobStatus> {
      guardHandle("ark", handle)
      const task = await client.get<ArkTaskResponse>(`/contents/generations/tasks/${handle.id}`)
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
      if (req.image) body["image"] = (await toUrlRef(req.image, "image/png")).url
      if (req.options) {
        const { size, watermark, responseFormat, ...rest } = req.options
        if (size) body["size"] = size
        if (watermark !== undefined) body["watermark"] = watermark
        Object.assign(body, rest)
      }
      const resp = await client.post<ArkImageResponse>("/images/generations", body, {
        timeoutMs: SLOW_POST_TIMEOUT_MS,
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

  async function toChatMessages(
    messages: Parameters<UnderstandApi<ArkChatOptions>["create"]>[0]["messages"],
    fileKind: "image_url" | "video_url",
  ) {
    const out = []
    for (const msg of messages) {
      out.push({
        role: msg.role,
        content:
          typeof msg.content === "string"
            ? msg.content
            : await Promise.all(
                msg.content.map(async (part) =>
                  typeof part === "string"
                    ? { type: "text", text: part }
                    : {
                        type: fileKind,
                        [fileKind]: { url: (await toUrlRef(part.file, "image/png")).url },
                      },
                ),
              ),
      })
    }
    return out
  }

  function understandApi(fileKind: "image_url" | "video_url"): UnderstandApi<ArkChatOptions> {
    return {
      async create(req) {
        const resp = await client.post<ArkChatResponse>("/chat/completions", {
          model: req.model,
          messages: await toChatMessages(req.messages, fileKind),
          ...(req.options ?? {}),
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
      const resp = await client.post<ArkEmbedResponse>("/embeddings", {
        model: req.model,
        input: req.inputs,
        ...(req.options ?? {}),
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
    models: ARK_MODELS,
    videoGenerate,
    videoUnderstand: understandApi("video_url"),
    imageGenerate,
    imageUnderstand: understandApi("image_url"),
    embed,
  }
}
