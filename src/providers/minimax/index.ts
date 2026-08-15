import { toUrlRef } from "../core/fileref"
import { createJsonClient, type JsonClient } from "../core/http"
import {
  type Env,
  type ImageGenerateApi,
  type JobHandle,
  type JobStatus,
  type Provider,
  ProviderError,
  type VideoGenerateApi,
} from "../core/types"
import { classifyMinimaxError } from "./error-map"
import { MINIMAX_MODELS } from "./models"

const DEFAULT_BASE_URL = "https://api.minimaxi.com"

// V2 resolution/duration 必填:https://platform.minimaxi.com/docs/api-reference/video-generation-v2-create
export interface MiniMaxVideoOptions {
  resolution: string
  duration: number
  ratio?: string
  [key: string]: unknown
}

export interface MiniMaxImageOptions {
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

interface MiniMaxTaskResponse {
  task_id?: string
  task?: {
    status?: string
    error?: { code?: number | string; message?: string }
    content?: { url?: string }
  }
}

interface MiniMaxImageResponse {
  data?: { image_urls?: string[]; image_base64?: string[] }
  metadata?: Record<string, unknown>
  base_resp?: { status_code?: number; status_msg?: string }
}

function checkBaseResp(body: { base_resp?: { status_code?: number; status_msg?: string } }): void {
  const code = body.base_resp?.status_code
  if (typeof code === "number" && code !== 0) {
    const category = classifyMinimaxError(200, body) ?? "internal"
    throw new ProviderError(category, body.base_resp?.status_msg ?? `code ${code}`, body)
  }
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

  const videoGenerate: VideoGenerateApi<MiniMaxVideoOptions> = {
    async submit(req) {
      if (!req.options?.resolution || req.options?.duration === undefined) {
        throw new ProviderError(
          "invalid",
          "MiniMax v2 requires options.resolution and options.duration",
        )
      }
      const { resolution, duration, ratio, ...rest } = req.options
      const content = await buildV2Content(
        req.prompt,
        req.firstFrame ? (await toUrlRef(req.firstFrame, "image/png")).url : undefined,
        req.lastFrame ? (await toUrlRef(req.lastFrame, "image/png")).url : undefined,
      )
      const body = await client.post<MiniMaxTaskResponse>("/v2/video_generation", {
        model: req.model,
        content,
        resolution,
        duration,
        ...(ratio ? { ratio } : {}),
        ...rest,
      })
      if (!body.task_id) {
        throw new ProviderError("internal", "MiniMax did not return task_id", body)
      }
      return { providerId: "minimax", id: body.task_id }
    },

    async poll(handle: JobHandle): Promise<JobStatus> {
      if (handle.providerId !== "minimax") {
        throw new ProviderError(
          "invalid",
          `handle belongs to '${handle.providerId}', not 'minimax'`,
        )
      }
      const body = await client.get<MiniMaxTaskResponse>(`/v2/query/video_generation/${handle.id}`)
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
    },
  }

  const imageGenerate: ImageGenerateApi<MiniMaxImageOptions> = {
    async create(req) {
      const body = await client.post<MiniMaxImageResponse>("/v1/image_generation", {
        model: req.model,
        prompt: req.prompt,
        ...(req.image
          ? {
              subject_reference: [
                { type: "character", image_file: (await toUrlRef(req.image, "image/png")).url },
              ],
            }
          : {}),
        ...(req.options ?? {}),
      })
      checkBaseResp(body)
      return {
        artifacts: [
          ...(body.data?.image_urls ?? []).map((url) => ({ url, mimeType: "image/png" })),
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
