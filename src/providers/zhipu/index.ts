import { mimeOfUrl, toImageUrl } from "../core/fileref"
import {
  createJsonClient,
  type JsonClient,
  SLOW_POST_TIMEOUT_MS,
  unwrapOrThrow,
} from "../core/http"
import { pollToArtifacts } from "../core/job"
import { mergeModelDeclarations } from "../core/modelRegistry"
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
/** Inline frame uploads and sync image generation; the default 30s timeout is tight for them. */

// Video generation (async): https://docs.bigmodel.cn/api-reference/model-api/video-generation-async
// Query async result: https://docs.bigmodel.cn/api-reference/model-api/query-async-result
// Image generation: https://docs.bigmodel.cn/api-reference/model-api/image-generation
// Image generation (async): https://docs.bigmodel.cn/api-reference/model-api/image-generation-async

/** Video params (snake_case passthrough, matching the API docs); per-model fields are noted in models.ts. */
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
  /** vidu2-reference multi-reference images (1-3 URL/data URIs); mutually exclusive with firstFrame */
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
   * Routes through the async task endpoint /async/images/generations with internal polling (glm-image only).
   * Default false: call the sync /images/generations directly.
   */
  useAsync?: boolean
  [key: string]: unknown
}

export interface ZhipuProviderConfig {
  apiKey?: string
  baseUrl?: string
  /** useAsync polling interval (default 2s) */
  pollIntervalMs?: number
  /** useAsync polling timeout (default 10 minutes) */
  pollTimeoutMs?: number
  /** User model declarations from config.json's models.zhipu (merged into the builtin list). */
  models?: unknown
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

/** FileRef → Zhipu image_url (URLs pass through; local files infer mime from extension; base64 falls back to image/png). */
async function toZhipuImageUrl(ref: FileRef): Promise<string> {
  return toImageUrl(ref)
}

/** Zhipu artifact URLs carry no content-type; infer from extension, fall back to image/png. */
function artifactMime(url: string | undefined): string {
  return mimeOfUrl(url) ?? "image/png"
}

function invalid(model: string, mode: ZhipuVideoMode, reason: string): ProviderError {
  return new ProviderError("invalid", `Zhipu model '${model}' (${MODE_LABEL[mode]}): ${reason}`)
}

/**
 * Fold firstFrame/lastFrame into the request body's image_url per model branch.
 * Returning undefined means the caller passed no frames (options.image_url passthrough stays).
 */
async function buildImageUrl(
  req: VideoGenerateRequest<ZhipuVideoOptions>,
  mode: ZhipuVideoMode,
): Promise<string | string[] | undefined> {
  const { firstFrame, lastFrame } = req
  if (!firstFrame) {
    // No first frame: either pure text-to-video, or a last frame with nowhere to go (array slot 0 is always the first frame)
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
      // single image = first frame; [first,last] two-image array = frame pair
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
  // Built-in verified list + user declarations (config.json models.zhipu):
  // custom video models MUST declare a ZhipuVideoMode they route to.
  const ALL_ZHIPU_MODES = [
    "cogvideox3",
    "cogvideox",
    "vidu-text",
    "vidu-image",
    "vidu-frames",
    "vidu-reference",
  ] as const
  const { models: mergedModels, modeFor } = mergeModelDeclarations(
    "zhipu",
    ZHIPU_MODELS,
    config.models,
    ALL_ZHIPU_MODES,
  )
  const modelModes: Record<string, ZhipuVideoMode> = {
    ...ZHIPU_VIDEO_MODEL_MODES,
    ...Object.fromEntries(
      Object.entries(modeFor).map(([id, mode]) => [id, mode as ZhipuVideoMode]),
    ),
  }

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

  /** GET /async-result/{id} → JobStatus; video and image tasks share this query endpoint. */
  async function pollAsyncResult(handle: JobHandle): Promise<JobStatus> {
    const body = unwrapOrThrow(
      await client.get<ZhipuAsyncResultResponse>(`/async-result/${handle.id}`),
    )
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
            // Failed responses usually carry status only, no error detail; content_filter hits classify as moderation
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
    async submit(req, ctx) {
      guardFrameSupport(mergedModels, req)
      // Runtime model ids come from user input; ids absent from the merged table fall to the cogvideox3 branch (historical default).
      const mode = modelModes[req.model as ZhipuModelId] ?? "cogvideox3"
      const { image_url: optionImages, ...rest } = req.options ?? {}
      const frames = await buildImageUrl(req, mode)

      const body: Record<string, unknown> = { model: req.model, prompt: req.prompt, ...rest }
      if (frames !== undefined) {
        body["image_url"] = frames
      } else if (optionImages !== undefined) {
        body["image_url"] = optionImages
      }

      const resp = unwrapOrThrow(
        await client.post<ZhipuAsyncCreateResponse>("/videos/generations", body, {
          timeoutMs: SLOW_POST_TIMEOUT_MS,
          signal: ctx?.signal,
        }),
      )
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

  /** Async task endpoint /async/images/generations: submit, then poll internally to completion. */
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
    const submitted = unwrapOrThrow(
      await client.post<ZhipuAsyncCreateResponse>(
        "/async/images/generations",
        {
          model: req.model,
          prompt: req.prompt,
          ...options,
        },
        { timeoutMs: SLOW_POST_TIMEOUT_MS },
      ),
    )
    if (!submitted.id) {
      throw new ProviderError("internal", "Zhipu did not return a task id", submitted)
    }
    const handle: JobHandle = { providerId: "zhipu", id: submitted.id }
    // Zhipu video/image async tasks share the /async-result/{id} query endpoint; timed-out tasks can be resumed there
    return pollToArtifacts(pollAsyncResult, handle, {
      intervalMs: config.pollIntervalMs ?? 2000,
      timeoutMs: config.pollTimeoutMs ?? 600_000,
      signal: ctx?.signal,
      label: "image generation",
    })
  }

  /** Sync endpoint /images/generations (glm-image / cogview-4-250304 / cogview-4 / cogview-3-flash). */
  async function createImageSync(
    req: ImageGenerateRequest<ZhipuImageOptions>,
    options: Record<string, unknown>,
  ): Promise<ImageGenerateResult> {
    const resp = unwrapOrThrow(
      await client.post<ZhipuImageSyncResponse>(
        "/images/generations",
        {
          model: req.model,
          prompt: req.prompt,
          ...options,
        },
        { timeoutMs: SLOW_POST_TIMEOUT_MS },
      ),
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

  /** Text chat: POST /chat/completions (OpenAI-compatible). */
  const textGenerate: TextGenerateApi<ZhipuChatOptions> = {
    async create(req) {
      const messages: Array<{ role: string; content: string }> = []
      if (req.system !== undefined) messages.push({ role: "system", content: req.system })
      messages.push({ role: "user", content: req.prompt })
      const resp = unwrapOrThrow(
        await client.post<ZhipuChatResponse>("/chat/completions", {
          model: req.model,
          messages,
          ...(req.options ?? {}),
        }),
      )
      return {
        text: resp.choices?.[0]?.message?.content ?? "",
        ...(resp.usage === undefined ? {} : { usage: { native: resp.usage } }),
      }
    },
  }

  return {
    id: "zhipu",
    models: mergedModels,
    defaultModels: ZHIPU_DEFAULT_MODELS,
    textGenerate,
    videoGenerate,
    imageGenerate,
  }
}
