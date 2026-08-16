import { toUrlRef } from "../core/fileref"
import { createJsonClient, type JsonClient } from "../core/http"
import {
  type Env,
  type FileRef,
  guardHandle,
  type ImageGenerateApi,
  type JobHandle,
  type JobStatus,
  type Provider,
  ProviderError,
  type VideoGenerateApi,
  type VideoGenerateRequest,
} from "../core/types"
import { guardFrameSupport } from "../core/validate"
import { classifyMinimaxError } from "./error-map"
import { MINIMAX_MODELS, MINIMAX_VIDEO_MODEL_MODES, type MiniMaxVideoMode } from "./models"

const DEFAULT_BASE_URL = "https://api.minimaxi.com"
/** 帧内联上传与同步图像生成,30s 默认超时偏紧。 */
const SLOW_POST_TIMEOUT_MS = 120_000

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
}

/** The concrete shape createMiniMaxProvider returns. */
export type MiniMaxProvider = Provider & {
  videoGenerate: VideoGenerateApi<MiniMaxVideoOptions>
  imageGenerate: ImageGenerateApi<MiniMaxImageOptions>
}

interface MiniMaxBaseResp {
  status_code?: number
  status_msg?: string
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

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
}

/** Artifact mime from the URL extension; API responses carry no content-type. */
function mimeOfUrl(url: string | undefined): string | undefined {
  const ext = url?.split("?")[0]?.split(".").pop()?.toLowerCase()
  return ext ? EXT_MIME[ext] : undefined
}

/** V1 image fields accept a URL or data URI; bare base64 gets an image/png hint. */
async function toV1ImageUrl(ref: FileRef): Promise<string> {
  return (await toUrlRef(ref, "base64" in ref ? "image/png" : undefined)).url
}

export function createMiniMaxProvider(
  config: MiniMaxProviderConfig = {},
  env: Env = process.env,
): MiniMaxProvider {
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

  // V1 handles carry apiVersion, but keep this in-memory set too so same-process
  // callers that strip extra JobHandle fields still poll the right endpoint.
  const v1TaskIds = new Set<string>()

  function isV1Handle(handle: JobHandle): boolean {
    return handle.apiVersion === "v1" || v1TaskIds.has(handle.id)
  }

  function modeForRequest(req: VideoGenerateRequest<MiniMaxVideoOptions>): MiniMaxVideoMode {
    const modes = MINIMAX_VIDEO_MODEL_MODES[req.model]
    // Unknown ids keep the historical MiniMax default (V2) rather than being guessed into V1.
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
  ): Promise<JobHandle> {
    const body: Record<string, unknown> = {
      model: req.model,
      prompt: req.prompt,
      ...v1BodyOptions(req.options, mode),
    }

    if (mode === "s2v") {
      body["subject_reference"] = await buildV1SubjectReference(req)
    } else if (mode === "fl2v") {
      body["last_frame_image"] = await toV1ImageUrl(
        req.lastFrame as NonNullable<typeof req.lastFrame>,
      )
      if (req.firstFrame) {
        body["first_frame_image"] = await toV1ImageUrl(req.firstFrame)
      }
    } else if (mode === "i2v") {
      body["first_frame_image"] = await toV1ImageUrl(
        req.firstFrame as NonNullable<typeof req.firstFrame>,
      )
    }

    const resp = await client.post<MiniMaxV1CreateResponse>("/v1/video_generation", body, {
      timeoutMs: SLOW_POST_TIMEOUT_MS,
    })
    checkBaseResp(resp)
    if (!resp.task_id) {
      throw new ProviderError("internal", "MiniMax did not return task_id", resp)
    }
    v1TaskIds.add(resp.task_id)
    return { providerId: "minimax", id: resp.task_id }
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

  async function submitV2(req: VideoGenerateRequest<MiniMaxVideoOptions>): Promise<JobHandle> {
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
      req.firstFrame ? (await toUrlRef(req.firstFrame, "image/png")).url : undefined,
      req.lastFrame ? (await toUrlRef(req.lastFrame, "image/png")).url : undefined,
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
      { timeoutMs: SLOW_POST_TIMEOUT_MS },
    )
    if (!body.task_id) {
      throw new ProviderError("internal", "MiniMax did not return task_id", body)
    }
    return { providerId: "minimax", id: body.task_id }
  }

  const videoGenerate: VideoGenerateApi<MiniMaxVideoOptions> = {
    async submit(req) {
      guardFrameSupport(MINIMAX_MODELS, req)
      const mode = modeForRequest(req)
      return mode === "v2" ? submitV2(req) : submitV1(req, mode)
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
                    image_file: (
                      await toUrlRef(req.image, "base64" in req.image ? "image/png" : undefined)
                    ).url,
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

  return {
    id: "minimax",
    models: MINIMAX_MODELS,
    videoGenerate,
    imageGenerate,
  }
}
