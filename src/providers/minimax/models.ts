import type { VerifiedModel } from "../core/types"

export const MINIMAX_MODELS: VerifiedModel[] = [
  {
    id: "MiniMax-H3",
    capabilities: {
      "video.generate": {
        textOnly: false,
        firstFrame: true,
        lastFrame: true,
        // reference_image/reference_video/reference_audio (r2va) 与首尾帧互斥,当前未建模
      },
    },
    lastVerified: "2026-08",
    note: "v2 端点唯一可用模型;resolution 768P|2K;duration 4-15;t2v 时 ratio 必填且不能 adaptive;last_frame 需与 first_frame 成对",
  },
  {
    id: "image-01",
    capabilities: { "image.generate": {} },
    lastVerified: "2026-08",
    note: "图生图走 subject_reference;产物 url 有效期 24h",
  },
  {
    id: "image-01-live",
    capabilities: { "image.generate": {} },
    lastVerified: "2026-08",
    note: "支持 style 画风设置;产物 url 有效期 24h",
  },
]
// MiniMax-Hailuo-02 属旧版 v1 视频接口,不在 v2 端点 model enum 中,故不登记
