import type { Capability, VerifiedModel } from "../core/types"

export const ZHIPU_DEFAULT_MODELS: Partial<Record<Capability, string>> = {
  "text.generate": "glm-4-flash",
  "image.generate": "cogview-3-flash",
  "video.generate": "cogvideox-flash",
}

/**
 * Maps video oneOf branches (request body shapes) to model ids.
 * https://docs.bigmodel.cn/api-reference/model-api/video-generation-async
 */
export type ZhipuVideoMode =
  | "cogvideox3" // cogvideox-3: single image_url or [first,last] frame array
  | "cogvideox" // cogvideox-2 / cogvideox-flash: single image only
  | "vidu-text" // viduq1-text: text-only
  | "vidu-image" // viduq1-image / vidu2-image: single first-frame image
  | "vidu-frames" // viduq1-start-end / vidu2-start-end: [first,last] frame pair
  | "vidu-reference" // vidu2-reference: 1-3 reference images

export type ZhipuModelId = (typeof ZHIPU_MODELS)[number]["id"]

export const ZHIPU_VIDEO_MODEL_MODES: Record<ZhipuModelId, ZhipuVideoMode> = {
  "cogvideox-3": "cogvideox3",
  "cogvideox-2": "cogvideox",
  "cogvideox-flash": "cogvideox",
  "viduq1-text": "vidu-text",
  "viduq1-image": "vidu-image",
  "vidu2-image": "vidu-image",
  "viduq1-start-end": "vidu-frames",
  "vidu2-start-end": "vidu-frames",
  "vidu2-reference": "vidu-reference",
}

export const ZHIPU_MODELS: VerifiedModel[] = [
  {
    id: "glm-4-flash",
    capabilities: { "text.generate": {} },
    lastVerified: "2026-08",
    note: "free tier text chat; chat/completions",
  },
  {
    id: "glm-4.5-air",
    capabilities: { "text.generate": {} },
    lastVerified: "2026-08",
    note: "cost-efficient text chat",
  },
  {
    id: "glm-4.6",
    capabilities: { "text.generate": {} },
    lastVerified: "2026-08",
    note: "flagship text chat; subject to console activation",
  },
  {
    id: "cogvideox-3",
    capabilities: {
      "video.generate": { textOnly: false, firstFrame: true, lastFrame: true },
    },
    lastVerified: "2026-08",
    note: "single image_url = first frame, auto-widened to [first,last] when lastFrame is set; size up to 4K; fps 30|60; duration 5|10",
  },
  {
    id: "cogvideox-2",
    capabilities: { "video.generate": { textOnly: false, firstFrame: true } },
    lastVerified: "2026-08",
    note: "single image_url only; no duration/with_audio params",
  },
  {
    id: "cogvideox-flash",
    capabilities: { "video.generate": { textOnly: false, firstFrame: true } },
    lastVerified: "2026-08",
    note: "free tier; single image_url only",
  },
  {
    id: "viduq1-text",
    capabilities: { "video.generate": { textOnly: true } },
    lastVerified: "2026-08",
    note: "text-only; style general|anime; aspect_ratio 16:9|9:16|1:1; duration 5",
  },
  {
    id: "viduq1-image",
    capabilities: { "video.generate": { textOnly: false, firstFrame: true } },
    lastVerified: "2026-08",
    note: "single first-frame image (png/jpeg/jpg/webp ≤50MB); duration 5; size 1920x1080",
  },
  {
    id: "vidu2-image",
    capabilities: { "video.generate": { textOnly: false, firstFrame: true } },
    lastVerified: "2026-08",
    note: "single first-frame image; duration 4; size 1280x720; with_audio only on the 4s variant",
  },
  {
    id: "viduq1-start-end",
    capabilities: {
      "video.generate": { textOnly: false, firstFrame: true, lastFrame: true },
    },
    lastVerified: "2026-08",
    note: "first+last frame pair (resolution ratio must be 0.8-1.25); duration 5; size 1920x1080",
  },
  {
    id: "vidu2-start-end",
    capabilities: {
      "video.generate": { textOnly: false, firstFrame: true, lastFrame: true },
    },
    lastVerified: "2026-08",
    note: "first+last frame pair; duration 4; size 1280x720|480x360",
  },
  {
    id: "vidu2-reference",
    capabilities: { "video.generate": { textOnly: false, firstFrame: true } },
    lastVerified: "2026-08",
    note: "reference-to-video with 1-3 reference images (firstFrame maps to a single-element array; more via options.image_url); duration 4; aspect_ratio 16:9|9:16|1:1",
  },
  {
    id: "glm-image",
    capabilities: { "image.generate": {} },
    lastVerified: "2026-08",
    note: "sync /images/generations or async /async/images/generations (options.useAsync); quality=hd only; size step 32",
  },
  {
    id: "cogview-4-250304",
    capabilities: { "image.generate": {} },
    lastVerified: "2026-08",
    note: "sync image generation; quality hd|standard; size must be divisible by 16",
  },
  {
    id: "cogview-4",
    capabilities: { "image.generate": {} },
    lastVerified: "2026-08",
    note: "sync image generation; quality hd|standard",
  },
  {
    id: "cogview-3-flash",
    capabilities: { "image.generate": {} },
    lastVerified: "2026-08",
    note: "free tier sync image generation",
  },
]
