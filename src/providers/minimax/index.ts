import { mimeOfUrl, toImageUrl } from "../core/fileref"
import { createJsonClient, type JsonClient, SLOW_POST_TIMEOUT_MS } from "../core/http"
import { mergeModelDeclarations } from "../core/modelRegistry"
import {
  type CallContext,
  type Env,
  type FileRef,
  guardHandle,
  type ImageGenerateApi,
  type JobHandle,
  type JobStatus,
  type Provider,
  ProviderError,
  type TextGenerateApi,
  type VideoGenerateApi,
  type VideoGenerateRequest,
} from "../core/types"
import { guardFrameSupport } from "../core/validate"
import { classifyMinimaxError } from "./error-map"
import {
  MINIMAX_DEFAULT_MODELS,
  MINIMAX_MODELS,
  MINIMAX_VIDEO_MODEL_MODES,
  type MiniMaxModelId,
  type MiniMaxVideoMode,
} from "./models"

const DEFAULT_BASE_URL = "https://api.minimaxi.com"
/** 帧内联上传与同步图像生成,30s 默认超时偏紧。 */

// Chat: https://platform.minimaxi.com/docs/api-reference/text-chat-openai
// V2 create: https://platform.minimaxi.com/docs/api-reference/video-generation-v2-create
// V1 create pages (all POST /v1/video_generation):
//   https://platform.minimaxi.com/docs/api-reference/video-generation-t2v
//   https://platform.minimaxi.com/docs/api-reference/video-generation-i2v
//   https://platform.minimaxi.com/docs/api-reference/video-generation-fl2v
//   https://platform.minimaxi.com/docs/api-reference/video-generation-s2v
// V1 query: https://platform.minimaxi.com/docs/api-reference/video-generation-query
// V1 download: https://platform.minimaxi.com/docs/api-reference/video-generation-download
export interface MiniMaxSubjectReference {
  type: "character"
  image: string[]
}

/** 文本对话参数(OpenAI 兼容透传): https://platform.minimaxi.com/docs/api-reference/text-chat-openai */
export interface MiniMaxChatOptions {
  /** [0, 2],M3 默认 1、M2.x 默认 1 */
  temperature?: number
  /** 核采样 [0, 1];M3 默认 0.95,M2.x 默认 0.9 */
  top_p?: number
  /** 生成长度上限;M3 推荐 131072/上限 524288,其余推荐 65536/上限 204800(max_tokens 已弃用) */
  max_completion_tokens?: number
  /** M3 thinking 控制 {type: "adaptive" | "off"};M2.x 无法关闭 */
  thinking?: Record<string, unknown>
  /** 将 thinking 拆分到 reasoning_content/reasoning_details;只改输出格式,不开关 thinking */
  reasoning_split?: boolean
  tools?: Array<Record<string, unknown>>
  service_tier?: "standard" | "priority"
  [key: string]: unknown
}

export interface MiniMaxVideoOptions {
  resolution?: "512P" | "720P" | "768P" | "1080P" | "2K"
  duration?: number
  ratio?: string
  prompt_optimizer?: boolean
  fast_pretreatment?: boolean
  aigc_watermark?: boolean
  callback_url?: string
  subject_reference?: MiniMaxSubjectReference[]
  [key: string]: unknown
}

// 图片生成参数(snake_case 透传,与 API 文档一致):
// https://platform.minimaxi.com/docs/api-reference/image-generation-t2i
export interface MiniMaxImageOptions {
  aspect_ratio?: string
  width?: number
  height?: number
  response_format?: "url" | "base64"
  seed?: number
  n?: number
  prompt_optimizer?: boolean
  aigc_watermark?: boolean
  style?: Record<string, unknown>
  [key: string]: unknown
}

export interface MiniMaxProviderConfig {
  apiKey?: string
  baseUrl?: string
  /** User model declarations from config.json's models.minimax (merged into the builtin list). */
  models?: unknown
}

/** The concrete shape createMiniMaxProvider returns. */
export type MiniMaxProvider = Provider & {
  textGenerate: TextGenerateApi<MiniMaxChatOptions>
  videoGenerate: VideoGenerateApi<MiniMaxVideoOptions>
  imageGenerate: ImageGenerateApi<MiniMaxImageOptions>
}

interface MiniMaxBaseResp {
  status_code?: number
  status_msg?: string
}

interface MiniMaxChatResponse {
  choices?: Array<{ message?: { content?: string } }>
  usage?: Record<string, unknown>
  base_resp?: MiniMaxBaseResp
}

interface MiniMaxV2TaskResponse {
  task_id?: string
  task?: {
    status?: string
    error?: { code?: number | string; message?: string }
    content?: { url?: string }
    usage?: Record<string, unknown>
  }
}

interface MiniMaxV1CreateResponse {
  task_id?: string
  base_resp?: MiniMaxBaseResp
}

interface MiniMaxV1QueryResponse {
  task_id?: string
  status?: string
  file_id?: string
  base_resp?: MiniMaxBaseResp
}

interface MiniMaxV1FileResponse {
  file?: { download_url?: string }
  base_resp?: MiniMaxBaseResp
}

interface MiniMaxImageResponse {
  data?: { image_urls?: string[]; image_base64?: string[] }
  metadata?: Record<string, unknown>
  base_resp?: MiniMaxBaseResp
}

function checkBaseResp(body: { base_resp?: MiniMaxBaseResp }): void {
  const code = body.base_resp?.status_code
  if (typeof code === "number" && code !== 0) {
    const category = classifyMinimaxError(200, body) ?? "internal"
    throw new ProviderError(category, body.base_resp?.status_msg ?? `code ${code}`, body)
  }
}

/**
 * MiniMax 默认把 thinking 内联在 content 首部(<think>…</think>),M2.x 无法关闭。
 * CLI 交付物只要正文,故剥离首个前导 think 块;未闭合或非前缀的 <think> 原样保留,
 * 用户传 options.reasoning_split=true 时服务端已拆分,此函数为空操作。
 */
function stripLeadingThink(text: string): string {
  if (!text.startsWith("<think>")) return text
  const end = text.indexOf("</think>")
  if (end === -1) return text
  return text.slice(end + "</think>".length).replace(/^\n+/, "")
}

/** V1 image fields accept a URL or data URI; bare base64 gets an image/png hint. */
async function toV1ImageUrl(ref: FileRef): Promise<string> {
  return toImageUrl(ref)
}

export function createMiniMaxProvider(
  config: MiniMaxProviderConfig = {},
  env: Env = process.env,
): MiniMaxProvider {
  // Built-in verified list + user declarations (config.json models.minimax):
  // custom video models MUST declare a mode they route to; overriding an
  // existing id retargets its protocol mode. Validated before credentials so
  // config errors surface first.
  const ALL_MINIMAX_MODES = ["v2", "t2v", "i2v", "fl2v", "s2v"] as const
  const { models: mergedModels, modeFor } = mergeModelDeclarations(
    "minimax",
    MINIMAX_MODELS,
    config.models,
    ALL_MINIMAX_MODES,
  )
  const modelModes: Record<string, MiniMaxVideoMode[]> = {
    ...MINIMAX_VIDEO_MODEL_MODES,
    // a declared mode explicitly retargets the id (custom append or builtin override)
    ...Object.fromEntries(
      Object.entries(modeFor).map(([id, mode]) => [id, [mode as MiniMaxVideoMode]]),
    ),
  }

  const apiKey = config.apiKey ?? env["MINIMAX_API_KEY"]
  if (!apiKey) {
    throw new ProviderError(
      "auth",
      "missing MiniMax API key: set MINIMAX_API_KEY or providers.minimax.apiKey in config",
    )
  }

  const client: JsonClient = createJsonClient({
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    headers: { authorization: `Bearer ${apiKey}` },
    classifyError: classifyMinimaxError,
  })

  function isV1Handle(handle: JobHandle): boolean {
    return handle.apiVersion === "v1"
  }

  function modeForRequest(req: VideoGenerateRequest<MiniMaxVideoOptions>): MiniMaxVideoMode {
    // 运行时模型 id 来自用户输入;未声明(不在合并表内)的 id 保持历史默认(V2)。
    const modes = modelModes[req.model as MiniMaxModelId]
    if (!modes) return "v2"
    if (modes.includes("v2")) return "v2"
    if (modes.includes("s2v")) return "s2v"

    const mode: MiniMaxVideoMode = req.lastFrame ? "fl2v" : req.firstFrame ? "i2v" : "t2v"
    if (modes && !modes.includes(mode)) {
      const label: Record<MiniMaxVideoMode, string> = {
        v2: "v2",
        t2v: "text-to-video",
        i2v: "image-to-video",
        fl2v: "first/last-frame-to-video",
        s2v: "subject-to-video",
      }
      throw new ProviderError(
        "invalid",
        `MiniMax model '${req.model}' does not support ${label[mode]} generation`,
      )
    }
    return mode
  }

  async function buildV2Content(
    prompt: string,
    firstFrameUrl: string | undefined,
    lastFrameUrl: string | undefined,
  ): Promise<Array<Record<string, unknown>>> {
    const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }]
    if (firstFrameUrl) {
      content.push({ type: "image_url", image_url: { url: firstFrameUrl }, role: "first_frame" })
    }
    if (lastFrameUrl) {
      content.push({ type: "image_url", image_url: { url: lastFrameUrl }, role: "last_frame" })
    }
    return content
  }

  /** V1 create params common to t2v/i2v/fl2v (V2-only keys are dropped). */
  function v1BodyOptions(
    options: MiniMaxVideoOptions | undefined,
    mode: MiniMaxVideoMode,
  ): Record<string, unknown> {
    if (!options) return {}
    const body: Record<string, unknown> = { ...options }
    delete body["ratio"]
    delete body["subject_reference"]
    if (mode === "s2v") {
      delete body["duration"]
      delete body["resolution"]
      delete body["fast_pretreatment"]
    }
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined) delete body[key]
    }
    return body
  }

  async function buildV1SubjectReference(
    req: VideoGenerateRequest<MiniMaxVideoOptions>,
  ): Promise<MiniMaxSubjectReference[]> {
    if (req.lastFrame) {
      throw new ProviderError("invalid", "MiniMax S2V-01 does not accept lastFrame")
    }
    const provided = req.options?.subject_reference
    if (provided && provided.length > 0) return provided
    if (!req.firstFrame) {
      throw new ProviderError(
        "invalid",
        "MiniMax S2V-01 requires options.subject_reference or firstFrame",
      )
    }
    return [
      {
        type: "character",
        image: [await toV1ImageUrl(req.firstFrame)],
      },
    ]
  }

  async function submitV1(
    req: VideoGenerateRequest<MiniMaxVideoOptions>,
    mode: MiniMaxVideoMode,
    ctx?: CallContext,
  ): Promise<JobHandle> {
    const body: Record<string, unknown> = {
      model: req.model,
      prompt: req.prompt,
      ...v1BodyOptions(req.options, mode),
    }

    if (mode === "s2v") {
      body["subject_reference"] = await buildV1SubjectReference(req)
    } else if (mode === "fl2v") {
      const last = req.lastFrame as NonNullable<typeof req.lastFrame>
      if (req.firstFrame) {
        const [firstUrl, lastUrl] = await Promise.all([
          toV1ImageUrl(req.firstFrame),
          toV1ImageUrl(last),
        ])
        body["first_frame_image"] = firstUrl
        body["last_frame_image"] = lastUrl
      } else {
        body["last_frame_image"] = await toV1ImageUrl(last)
      }
    } else if (mode === "i2v") {
      body["first_frame_image"] = await toV1ImageUrl(
        req.firstFrame as NonNullable<typeof req.firstFrame>,
      )
    }

    const resp = await client.post<MiniMaxV1CreateResponse>("/v1/video_generation", body, {
      timeoutMs: SLOW_POST_TIMEOUT_MS,
      signal: ctx?.signal,
    })
    checkBaseResp(resp)
    if (!resp.task_id) {
      throw new ProviderError("internal", "MiniMax did not return task_id", resp)
    }
    return { providerId: "minimax", id: resp.task_id, apiVersion: "v1" }
  }

  async function pollV1(handle: JobHandle): Promise<JobStatus> {
    const query = await client.get<MiniMaxV1QueryResponse>(
      `/v1/query/video_generation?task_id=${encodeURIComponent(handle.id)}`,
    )
    checkBaseResp(query)

    switch (query.status?.toLowerCase()) {
      case "preparing":
      case "queueing":
        return { state: "pending" }
      case "processing":
        return { state: "running" }
      case "success": {
        if (!query.file_id) {
          throw new ProviderError("internal", "MiniMax query returned no file_id", query)
        }
        const file = await client.get<MiniMaxV1FileResponse>(
          `/v1/files/retrieve?file_id=${encodeURIComponent(query.file_id)}`,
        )
        checkBaseResp(file)
        const url = file.file?.download_url
        if (!url) {
          throw new ProviderError(
            "internal",
            "MiniMax file retrieve returned no download_url",
            file,
          )
        }
        return {
          state: "done",
          artifacts: [{ url, mimeType: "video/mp4" }],
        }
      }
      case "fail":
        return {
          state: "failed",
          error: {
            category: classifyMinimaxError(200, query) ?? "internal",
            raw: query,
          },
        }
      default:
        return { state: "pending" }
    }
  }

  async function pollV2(handle: JobHandle): Promise<JobStatus> {
    const body = await client.get<MiniMaxV2TaskResponse>(`/v2/query/video_generation/${handle.id}`)
    const task = body.task
    switch (task?.status) {
      case "queued":
        return { state: "pending" }
      case "running":
        return { state: "running" }
      case "succeeded":
        return {
          state: "done",
          artifacts: [{ url: task.content?.url, mimeType: "video/mp4" }],
          usage: task.usage ? { native: task.usage } : undefined,
        }
      case "failed":
      case "cancelled":
        return {
          state: "failed",
          error: {
            category:
              classifyMinimaxError(200, { error: { message: task.error?.message ?? "" } }) ??
              "internal",
            raw: task.error,
          },
        }
      default:
        return { state: "pending" }
    }
  }

  async function submitV2(
    req: VideoGenerateRequest<MiniMaxVideoOptions>,
    ctx?: CallContext,
  ): Promise<JobHandle> {
    if (!req.options?.resolution || req.options?.duration === undefined) {
      throw new ProviderError(
        "invalid",
        "MiniMax v2 requires options.resolution and options.duration",
      )
    }
    if (req.options.duration < 4 || req.options.duration > 15) {
      throw new ProviderError("invalid", "MiniMax v2 duration must be 4-15 seconds")
    }
    const { resolution, duration, ratio, ...rest } = req.options
    const content = await buildV2Content(
      req.prompt,
      req.firstFrame ? await toImageUrl(req.firstFrame) : undefined,
      req.lastFrame ? await toImageUrl(req.lastFrame) : undefined,
    )
    const body = await client.post<MiniMaxV2TaskResponse>(
      "/v2/video_generation",
      {
        model: req.model,
        content,
        resolution,
        duration,
        ...(ratio ? { ratio } : {}),
        ...rest,
      },
      { timeoutMs: SLOW_POST_TIMEOUT_MS, signal: ctx?.signal },
    )
    if (!body.task_id) {
      throw new ProviderError("internal", "MiniMax did not return task_id", body)
    }
    return { providerId: "minimax", id: body.task_id }
  }

  const videoGenerate: VideoGenerateApi<MiniMaxVideoOptions> = {
    async submit(req, ctx) {
      guardFrameSupport(mergedModels, req)
      const mode = modeForRequest(req)
      return mode === "v2" ? submitV2(req, ctx) : submitV1(req, mode, ctx)
    },

    // V2: DELETE /v2/video_generation/{task_id} (V1 has no cancel endpoint)
    // https://platform.minimaxi.com/docs/api-reference/video-generation-v2-delete
    async cancel(handle: JobHandle): Promise<void> {
      guardHandle("minimax", handle)
      if (isV1Handle(handle)) {
        throw new ProviderError("invalid", "MiniMax v1 video generation has no cancel endpoint")
      }
      await client.del(`/v2/video_generation/${handle.id}`)
    },

    async poll(handle: JobHandle): Promise<JobStatus> {
      guardHandle("minimax", handle)
      return isV1Handle(handle) ? pollV1(handle) : pollV2(handle)
    },
  }

  const imageGenerate: ImageGenerateApi<MiniMaxImageOptions> = {
    async create(req) {
      const body = await client.post<MiniMaxImageResponse>(
        "/v1/image_generation",
        {
          model: req.model,
          prompt: req.prompt,
          ...(req.image
            ? {
                // JPG/JPEG/PNG data URL 或公网 URL;mime 按扩展名推断,base64 兜底 png
                subject_reference: [
                  {
                    type: "character",
                    image_file: await toImageUrl(req.image),
                  },
                ],
              }
            : {}),
          ...(req.options ?? {}),
        },
        { timeoutMs: SLOW_POST_TIMEOUT_MS },
      )
      checkBaseResp(body)
      return {
        artifacts: [
          ...(body.data?.image_urls ?? []).map((url) => ({
            url,
            mimeType: mimeOfUrl(url) ?? "image/png",
          })),
          ...(body.data?.image_base64 ?? []).map((base64) => ({ base64, mimeType: "image/png" })),
        ],
        usage: body.metadata ? { native: body.metadata } : undefined,
      }
    },
  }

  /** 文本对话: POST /v1/chat/completions(OpenAI 兼容)。 */
  const textGenerate: TextGenerateApi<MiniMaxChatOptions> = {
    async create(req, ctx) {
      const messages: Array<{ role: string; content: string }> = []
      if (req.system !== undefined) messages.push({ role: "system", content: req.system })
      messages.push({ role: "user", content: req.prompt })
      const resp = await client.post<MiniMaxChatResponse>(
        "/v1/chat/completions",
        {
          model: req.model,
          messages,
          ...(req.options ?? {}),
        },
        { signal: ctx?.signal },
      )
      checkBaseResp(resp)
      return {
        text: stripLeadingThink(resp.choices?.[0]?.message?.content ?? ""),
        ...(resp.usage === undefined ? {} : { usage: { native: resp.usage } }),
      }
    },
  }

  return {
    id: "minimax",
    models: mergedModels,
    defaultModels: MINIMAX_DEFAULT_MODELS,
    textGenerate,
    videoGenerate,
    imageGenerate,
  }
}
