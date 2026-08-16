import type { VerifiedModel } from "../core/types"

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
    capabilities: { "image.generate": {} },
    lastVerified: "2026-08",
    note: "图片生成模型",
  },
]
