import { toUrlRef } from "../core/fileref"
import { createJsonClient, type JsonClient } from "../core/http"
import { JobTimeoutError, pollUntil } from "../core/job"
import {
  type Env,
  type FileRef,
  type ImageGenerateApi,
  type ImageGenerateRequest,
  type ImageGenerateResult,
  type JobHandle,
  type JobStatus,
  type Provider,
  ProviderError,
  type VideoGenerateApi,
  type VideoGenerateRequest,
} from "../core/types"
import { classifyZhipuError } from "./error-map"
import { ZHIPU_MODELS, ZHIPU_VIDEO_MODEL_MODES, type ZhipuVideoMode } from "./models"

const DEFAULT_BASE_URL = "https://open.bigmodel.cn/api"

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

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
}

function mimeOfUrl(url: string | undefined): string {
  const ext = url?.split("?")[0]?.split(".").pop()?.toLowerCase()
  return (ext && EXT_MIME[ext]) || "image/png"
}

/** FileRef → 智谱 image_url(URL 原样,本地图/base64 转 data URI,兜底 image/png)。 */
async function toZhipuImageUrl(ref: FileRef): Promise<string> {
  return (await toUrlRef(ref, "base64" in ref ? "image/png" : undefined)).url
}

const MODE_LABEL: Record<ZhipuVideoMode, string> = {
  cogvideox3: "CogVideoX-3",
  cogvideox: "CogVideoX",
  "vidu-text": "Vidu text-to-video",
  "vidu-image": "Vidu image-to-video",
  "vidu-frames": "Vidu first/last-frame-to-video",
  "vidu-reference": "Vidu reference-to-video",
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
      if (lastFrame) return [await toZhipuImageUrl(firstFrame), await toZhipuImageUrl(lastFrame)]
      return await toZhipuImageUrl(firstFrame)
    case "cogvideox":
    case "vidu-image":
      if (lastFrame)
        throw invalid(req.model, mode, "does not support lastFrame (single image only)")
      return await toZhipuImageUrl(firstFrame)
    case "vidu-text":
      throw invalid(req.model, mode, "does not accept image input")
    case "vidu-frames":
      if (lastFrame) return [await toZhipuImageUrl(firstFrame), await toZhipuImageUrl(lastFrame)]
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
          ...(body.image_result ?? []).map((i) => ({ url: i.url, mimeType: mimeOfUrl(i.url) })),
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
      const mode = ZHIPU_VIDEO_MODEL_MODES[req.model] ?? "cogvideox3"
      const { image_url: optionImages, ...rest } = req.options ?? {}
      const frames = await buildImageUrl(req, mode)

      const body: Record<string, unknown> = { model: req.model, prompt: req.prompt, ...rest }
      if (frames !== undefined) {
        body["image_url"] = frames
      } else if (optionImages !== undefined) {
        body["image_url"] = optionImages
      }

      const resp = await client.post<ZhipuAsyncCreateResponse>("/videos/generations", body)
      if (!resp.id) {
        throw new ProviderError("internal", "Zhipu did not return a task id", resp)
      }
      return { providerId: "zhipu", id: resp.id }
    },

    async poll(handle: JobHandle): Promise<JobStatus> {
      if (handle.providerId !== "zhipu") {
        throw new ProviderError("invalid", `handle belongs to '${handle.providerId}', not 'zhipu'`)
      }
      return pollAsyncResult(handle)
    },
  }

  /** 异步任务端点 /async/images/generations:提交后内部轮询到收口。 */
  async function createImageAsync(
    req: ImageGenerateRequest<ZhipuImageOptions>,
    options: Record<string, unknown>,
  ): Promise<ImageGenerateResult> {
    if (req.model !== "glm-image") {
      throw new ProviderError(
        "invalid",
        "Zhipu async image generation only supports model 'glm-image'",
      )
    }
    const submitted = await client.post<ZhipuAsyncCreateResponse>("/async/images/generations", {
      model: req.model,
      prompt: req.prompt,
      ...options,
    })
    if (!submitted.id) {
      throw new ProviderError("internal", "Zhipu did not return a task id", submitted)
    }
    const handle: JobHandle = { providerId: "zhipu", id: submitted.id }
    const final = await pollUntil(pollAsyncResult, handle, {
      intervalMs: config.pollIntervalMs ?? 2000,
      timeoutMs: config.pollTimeoutMs ?? 600_000,
    }).catch((e: unknown) => {
      if (e instanceof JobTimeoutError) {
        throw new ProviderError("internal", `image generation timed out (task ${handle.id})`)
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
    const resp = await client.post<ZhipuImageSyncResponse>("/images/generations", {
      model: req.model,
      prompt: req.prompt,
      ...options,
    })
    const urls = (resp.data ?? [])
      .map((item) => item.url)
      .filter((url): url is string => typeof url === "string")
    if (urls.length === 0) {
      throw new ProviderError("internal", "Zhipu image generation returned no images", resp)
    }
    return { artifacts: urls.map((url) => ({ url, mimeType: mimeOfUrl(url) })) }
  }

  const imageGenerate: ImageGenerateApi<ZhipuImageOptions> = {
    async create(req): Promise<ImageGenerateResult> {
      const { useAsync, ...options } = req.options ?? {}
      return useAsync ? createImageAsync(req, options) : createImageSync(req, options)
    },
  }

  return {
    id: "zhipu",
    models: ZHIPU_MODELS,
    videoGenerate,
    imageGenerate,
  }
}
