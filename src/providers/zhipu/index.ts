import { mimeOfUrl, toImageUrl } from "../core/fileref"
import { createJsonClient, type JsonClient, SLOW_POST_TIMEOUT_MS } from "../core/http"
import { JobTimeoutError, pollUntil } from "../core/job"
import {
  type CallContext,
  type Env,
  type FileRef,
  guardHandle,
  type ImageGenerateApi,
  type ImageGenerateRequest,
  type ImageGenerateResult,
  type JobHandle,
  type JobStatus,
  type Provider,
  ProviderError,
  type TextGenerateApi,
  type VideoGenerateApi,
  type VideoGenerateRequest,
} from "../core/types"
import { guardFrameSupport } from "../core/validate"
import { classifyZhipuError } from "./error-map"
import {
  ZHIPU_DEFAULT_MODELS,
  ZHIPU_MODELS,
  ZHIPU_VIDEO_MODEL_MODES,
  type ZhipuModelId,
  type ZhipuVideoMode,
} from "./models"

const DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/paas/v4"
/** 帧内联上传与同步图像生成,30s 默认超时偏紧。 */

// 视频生成(异步): https://docs.bigmodel.cn/api-reference/模型-api/视频生成异步
// 查询异步结果: https://docs.bigmodel.cn/api-reference/模型-api/查询异步结果
// 图像生成: https://docs.bigmodel.cn/api-reference/模型-api/图像生成
// 图像生成(异步): https://docs.bigmodel.cn/api-reference/模型-api/图像生成异步

/** 视频入参(snake_case 透传,与 API 文档一致);各模型可用字段见 models.ts 备注。 */
export interface ZhipuVideoOptions {
  quality?: "speed" | "quality"
  with_audio?: boolean
  watermark_enabled?: boolean
  size?: string
  fps?: 30 | 60
  duration?: 5 | 10 | 4
  style?: "general" | "anime"
  aspect_ratio?: "16:9" | "9:16" | "1:1"
  movement_amplitude?: "auto" | "small" | "medium" | "large"
  /** vidu2-reference 多参考图(1-3 张 URL/data URI);与 firstFrame 二选一 */
  image_url?: string | string[]
  request_id?: string
  user_id?: string
  [key: string]: unknown
}

export interface ZhipuChatOptions {
  temperature?: number
  top_p?: number
  max_tokens?: number
  [key: string]: unknown
}

export interface ZhipuImageOptions {
  quality?: "hd" | "standard"
  size?: string
  watermark_enabled?: boolean
  user_id?: string
  /**
   * 走异步任务端点 /async/images/generations 并内部轮询收口(仅 glm-image)。
   * 默认 false:直接调用同步 /images/generations。
   */
  useAsync?: boolean
  [key: string]: unknown
}

export interface ZhipuProviderConfig {
  apiKey?: string
  baseUrl?: string
  /** useAsync 轮询间隔(默认 2s) */
  pollIntervalMs?: number
  /** useAsync 轮询超时(默认 10 分钟) */
  pollTimeoutMs?: number
}

/** The concrete shape createZhipuProvider returns. */
export type ZhipuProvider = Provider & {
  textGenerate: TextGenerateApi<ZhipuChatOptions>
  videoGenerate: VideoGenerateApi<ZhipuVideoOptions>
  imageGenerate: ImageGenerateApi<ZhipuImageOptions>
}

interface ZhipuAsyncCreateResponse {
  id?: string
  request_id?: string
  task_status?: string
}

interface ZhipuAsyncResultResponse {
  id?: string
  model?: string
  created?: number
  task_status?: string
  video_result?: Array<{ url?: string; cover_image_url?: string }>
  image_result?: Array<{ url?: string }>
  content_filter?: Array<{ role?: string; level?: number }>
}

interface ZhipuImageSyncResponse {
  created?: number
  data?: Array<{ url?: string }>
  content_filter?: Array<{ role?: string; level?: number }>
}

interface ZhipuChatResponse {
  choices?: Array<{ message?: { content?: string } }>
  usage?: Record<string, unknown>
}

const MODE_LABEL: Record<ZhipuVideoMode, string> = {
  cogvideox3: "CogVideoX-3",
  cogvideox: "CogVideoX",
  "vidu-text": "Vidu text-to-video",
  "vidu-image": "Vidu image-to-video",
  "vidu-frames": "Vidu first/last-frame-to-video",
  "vidu-reference": "Vidu reference-to-video",
}

/** FileRef → 智谱 image_url(URL 原样,本地图按扩展名,base64 兜底 image/png)。 */
async function toZhipuImageUrl(ref: FileRef): Promise<string> {
  return toImageUrl(ref)
}

/** 智谱产物 URL 无 content-type;按扩展名推断,未知兜底 image/png。 */
function artifactMime(url: string | undefined): string {
  return mimeOfUrl(url) ?? "image/png"
}

function invalid(model: string, mode: ZhipuVideoMode, reason: string): ProviderError {
  return new ProviderError("invalid", `Zhipu model '${model}' (${MODE_LABEL[mode]}): ${reason}`)
}

/**
 * 按模型分支把 firstFrame/lastFrame 折算成请求体的 image_url。
 * 返回 undefined 表示调用方未传帧(保留 options.image_url 透传)。
 */
async function buildImageUrl(
  req: VideoGenerateRequest<ZhipuVideoOptions>,
  mode: ZhipuVideoMode,
): Promise<string | string[] | undefined> {
  const { firstFrame, lastFrame } = req
  if (!firstFrame) {
    // 没有首帧:要么纯文生,要么只有尾帧(无处安放,数组第一张固定是首帧)
    if (lastFrame) {
      throw invalid(
        req.model,
        mode,
        "lastFrame requires firstFrame (image_url order is [first, last])",
      )
    }
    return undefined
  }

  switch (mode) {
    case "cogvideox3":
      // 单图=首帧;[首帧,尾帧] 两图数组=首尾帧
      if (lastFrame) {
        const [first, last] = await Promise.all([
          toZhipuImageUrl(firstFrame),
          toZhipuImageUrl(lastFrame),
        ])
        return [first, last]
      }
      return await toZhipuImageUrl(firstFrame)
    case "cogvideox":
    case "vidu-image":
      if (lastFrame)
        throw invalid(req.model, mode, "does not support lastFrame (single image only)")
      return await toZhipuImageUrl(firstFrame)
    case "vidu-text":
      throw invalid(req.model, mode, "does not accept image input")
    case "vidu-frames":
      if (lastFrame) {
        const [first, last] = await Promise.all([
          toZhipuImageUrl(firstFrame),
          toZhipuImageUrl(lastFrame),
        ])
        return [first, last]
      }
      return [await toZhipuImageUrl(firstFrame)]
    case "vidu-reference":
      if (lastFrame)
        throw invalid(req.model, mode, "does not support lastFrame (1-3 reference images)")
      return [await toZhipuImageUrl(firstFrame)]
  }
}

export function createZhipuProvider(
  config: ZhipuProviderConfig = {},
  env: Env = process.env,
): ZhipuProvider {
  const apiKey = config.apiKey ?? env["ZHIPU_API_KEY"] ?? env["BIGMODEL_API_KEY"]
  if (!apiKey) {
    throw new ProviderError(
      "auth",
      "missing Zhipu API key: set ZHIPU_API_KEY or providers.zhipu.apiKey in config",
    )
  }
  const client: JsonClient = createJsonClient({
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    headers: { authorization: `Bearer ${apiKey}` },
    classifyError: classifyZhipuError,
  })

  /** GET /async-result/{id} → JobStatus,视频/图像任务共用同一查询端点。 */
  async function pollAsyncResult(handle: JobHandle): Promise<JobStatus> {
    const body = await client.get<ZhipuAsyncResultResponse>(`/async-result/${handle.id}`)
    switch (body.task_status) {
      case "PROCESSING":
        return { state: "running" }
      case "SUCCESS": {
        const artifacts = [
          ...(body.video_result ?? []).map((v) => ({
            url: v.url,
            mimeType: "video/mp4",
          })),
          ...(body.image_result ?? []).map((i) => ({ url: i.url, mimeType: artifactMime(i.url) })),
        ]
        if (artifacts.length === 0) {
          throw new ProviderError("internal", "Zhipu async result returned no artifacts", body)
        }
        return { state: "done", artifacts }
      }
      case "FAIL":
        return {
          state: "failed",
          error: {
            // 失败响应通常只有状态无错误详情;content_filter 命中时按内容安全归类
            category:
              (body.content_filter?.length ?? 0) > 0
                ? "moderation"
                : (classifyZhipuError(200, body) ?? "internal"),
            raw: body,
          },
        }
      default:
        return { state: "pending" }
    }
  }

  const videoGenerate: VideoGenerateApi<ZhipuVideoOptions> = {
    async submit(req) {
      guardFrameSupport(ZHIPU_MODELS, req)
      // 运行时模型 id 来自用户输入;未知 id 落到 cogvideox3 分支(历史默认)。
      const mode = ZHIPU_VIDEO_MODEL_MODES[req.model as ZhipuModelId] ?? "cogvideox3"
      const { image_url: optionImages, ...rest } = req.options ?? {}
      const frames = await buildImageUrl(req, mode)

      const body: Record<string, unknown> = { model: req.model, prompt: req.prompt, ...rest }
      if (frames !== undefined) {
        body["image_url"] = frames
      } else if (optionImages !== undefined) {
        body["image_url"] = optionImages
      }

      const resp = await client.post<ZhipuAsyncCreateResponse>("/videos/generations", body, {
        timeoutMs: SLOW_POST_TIMEOUT_MS,
      })
      if (!resp.id) {
        throw new ProviderError("internal", "Zhipu did not return a task id", resp)
      }
      return { providerId: "zhipu", id: resp.id }
    },

    async poll(handle: JobHandle): Promise<JobStatus> {
      guardHandle("zhipu", handle)
      return pollAsyncResult(handle)
    },
  }

  /** 异步任务端点 /async/images/generations:提交后内部轮询到收口。 */
  async function createImageAsync(
    req: ImageGenerateRequest<ZhipuImageOptions>,
    options: Record<string, unknown>,
    ctx: CallContext | undefined,
  ): Promise<ImageGenerateResult> {
    if (req.model !== "glm-image") {
      throw new ProviderError(
        "invalid",
        "Zhipu async image generation only supports model 'glm-image'",
      )
    }
    const submitted = await client.post<ZhipuAsyncCreateResponse>(
      "/async/images/generations",
      {
        model: req.model,
        prompt: req.prompt,
        ...options,
      },
      { timeoutMs: SLOW_POST_TIMEOUT_MS },
    )
    if (!submitted.id) {
      throw new ProviderError("internal", "Zhipu did not return a task id", submitted)
    }
    const handle: JobHandle = { providerId: "zhipu", id: submitted.id }
    const final = await pollUntil(pollAsyncResult, handle, {
      intervalMs: config.pollIntervalMs ?? 2000,
      timeoutMs: config.pollTimeoutMs ?? 600_000,
      signal: ctx?.signal,
    }).catch((e: unknown) => {
      if (e instanceof JobTimeoutError) {
        // raw 带上任务号:该任务仍可用 videoGenerate.poll(handle) 续查
        // (智谱视频/图像异步任务共用 /async-result/{id} 查询端点)
        throw new ProviderError("internal", `image generation timed out (task ${handle.id})`, {
          taskId: handle.id,
        })
      }
      throw e
    })
    if (final.state === "done") return { artifacts: final.artifacts }
    throw new ProviderError(
      final.error.category,
      `image generation failed (task ${handle.id})`,
      final.error.raw,
    )
  }

  /** 同步端点 /images/generations(glm-image / cogview-4-250304 / cogview-4 / cogview-3-flash)。 */
  async function createImageSync(
    req: ImageGenerateRequest<ZhipuImageOptions>,
    options: Record<string, unknown>,
  ): Promise<ImageGenerateResult> {
    const resp = await client.post<ZhipuImageSyncResponse>(
      "/images/generations",
      {
        model: req.model,
        prompt: req.prompt,
        ...options,
      },
      { timeoutMs: SLOW_POST_TIMEOUT_MS },
    )
    const urls = (resp.data ?? [])
      .map((item) => item.url)
      .filter((url): url is string => typeof url === "string")
    if (urls.length === 0) {
      throw new ProviderError("internal", "Zhipu image generation returned no images", resp)
    }
    return { artifacts: urls.map((url) => ({ url, mimeType: artifactMime(url) })) }
  }

  const imageGenerate: ImageGenerateApi<ZhipuImageOptions> = {
    async create(req, ctx): Promise<ImageGenerateResult> {
      const { useAsync, ...options } = req.options ?? {}
      return useAsync ? createImageAsync(req, options, ctx) : createImageSync(req, options)
    },
  }

  /** 文本对话: POST /chat/completions(OpenAI 兼容)。 */
  const textGenerate: TextGenerateApi<ZhipuChatOptions> = {
    async create(req) {
      const messages: Array<{ role: string; content: string }> = []
      if (req.system !== undefined) messages.push({ role: "system", content: req.system })
      messages.push({ role: "user", content: req.prompt })
      const resp = await client.post<ZhipuChatResponse>("/chat/completions", {
        model: req.model,
        messages,
        ...(req.options ?? {}),
      })
      return {
        text: resp.choices?.[0]?.message?.content ?? "",
        ...(resp.usage === undefined ? {} : { usage: { native: resp.usage } }),
      }
    },
  }

  return {
    id: "zhipu",
    models: ZHIPU_MODELS,
    defaultModels: ZHIPU_DEFAULT_MODELS,
    textGenerate,
    videoGenerate,
    imageGenerate,
  }
}
