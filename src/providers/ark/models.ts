import type { Capability, VerifiedModel } from "../core/types"

export const ARK_DEFAULT_MODELS: Partial<Record<Capability, string>> = {
  "text.generate": "doubao-seed-1-6-250615",
  "image.generate": "doubao-seedream-4.0-250828",
  "video.generate": "doubao-seedance-2.0",
  "image.understand": "doubao-1.5-vision-pro-32k-250115",
  embed: "doubao-embedding-large-text-240915",
}

export const ARK_MODELS: VerifiedModel[] = [
  {
    id: "doubao-seed-1-6-250615",
    capabilities: { "text.generate": {} },
    lastVerified: "2026-08",
    note: "文本对话;以方舟控制台开通的 endpoint/model 为准",
  },
  {
    id: "doubao-1-5-pro-32k-250115",
    capabilities: { "text.generate": {} },
    lastVerified: "2026-08",
    note: "高性价比文本对话",
  },
  {
    id: "doubao-seedance-1-0-pro-250528",
    capabilities: {
      "video.generate": { textOnly: false, firstFrame: true, lastFrame: false },
    },
    lastVerified: "2026-08",
    note: "官方示例模型 ID,使用前以方舟控制台开通的 endpoint/model 为准",
  },
  {
    id: "doubao-seedance-2.0",
    capabilities: {
      "video.generate": { textOnly: false, firstFrame: true, lastFrame: true },
    },
    lastVerified: "2026-08",
    note: "另有 reference_image role(2.0/2.5)",
  },
  {
    id: "doubao-seedream-4.0-250828",
    capabilities: { "image.generate": {} },
    lastVerified: "2026-08",
  },
  {
    id: "doubao-1.5-vision-pro-32k-250115",
    capabilities: { "image.understand": {}, "video.understand": {} },
    lastVerified: "2026-08",
  },
  {
    id: "doubao-embedding-large-text-240915",
    capabilities: { embed: {} },
    lastVerified: "2026-08",
    note: "文本端点无 dimensions;多模态 dimensions 在 /embeddings/multimodal",
  },
]
