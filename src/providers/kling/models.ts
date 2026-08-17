import type { Capability, VerifiedModel } from "../core/types"

export const KLING_DEFAULT_MODELS: Partial<Record<Capability, string>> = {
  "image.generate": "kolors",
  "video.generate": "kling-3.0-turbo",
}

export const KLING_MODELS: VerifiedModel[] = [
  {
    id: "kling-3.0-turbo",
    capabilities: { "video.generate": { textOnly: false, firstFrame: true } },
    lastVerified: "2026-08",
    note: "路径族 /text-to-video/kling-3.0-turbo 与 /image-to-video/kling-3.0-turbo",
  },
  {
    id: "kling-v2.1-turbo",
    capabilities: { "video.generate": { textOnly: false, firstFrame: true } },
    lastVerified: "2026-08",
  },
  {
    id: "kolors",
    capabilities: { "image.generate": { imageInput: true } },
    lastVerified: "2026-08",
    note: "图片生成模型;传 image 时走图生图",
  },
]
