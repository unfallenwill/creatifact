import type { VerifiedModel } from "../core/types"

export const MINIMAX_MODELS: VerifiedModel[] = [
  {
    id: "MiniMax-H3",
    capabilities: {
      "video.generate": { textOnly: false, firstFrame: true, lastFrame: true },
    },
    lastVerified: "2026-08",
    note: "v2 端点;resolution/duration 必填;last_frame 需与 first_frame 成对",
  },
  {
    id: "MiniMax-Hailuo-02",
    capabilities: { "video.generate": { textOnly: false, firstFrame: true } },
    lastVerified: "2026-08",
  },
  {
    id: "image-01",
    capabilities: { "image.generate": {} },
    lastVerified: "2026-08",
    note: "图生图走 subject_reference;产物 url 有效期 24h",
  },
]
