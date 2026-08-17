import type { Capability, VerifiedModel } from "../core/types"

export const MINIMAX_DEFAULT_MODELS: Partial<Record<Capability, string>> = {
  "image.generate": "image-01",
  "video.generate": "MiniMax-H3",
}

export type MiniMaxVideoMode = "v2" | "t2v" | "i2v" | "fl2v" | "s2v"

/**
 * Which V1 create payload each model accepts.  All V1 modes share
 * POST /v1/video_generation; the request body determines the mode.
 */
export type MiniMaxModelId = (typeof MINIMAX_MODELS)[number]["id"]

export const MINIMAX_VIDEO_MODEL_MODES: Record<MiniMaxModelId, MiniMaxVideoMode[]> = {
  "MiniMax-H3": ["v2"],
  "MiniMax-Hailuo-2.3": ["t2v", "i2v"],
  "MiniMax-Hailuo-2.3-Fast": ["i2v"],
  "MiniMax-Hailuo-02": ["t2v", "i2v", "fl2v"],
  "T2V-01-Director": ["t2v"],
  "T2V-01": ["t2v"],
  "I2V-01-Director": ["i2v"],
  "I2V-01-live": ["i2v"],
  "I2V-01": ["i2v"],
  "S2V-01": ["s2v"],
}

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
    id: "MiniMax-Hailuo-2.3",
    capabilities: { "video.generate": { textOnly: false, firstFrame: true } },
    lastVerified: "2026-08",
    note: "v1 t2v/i2v;duration 6|10;resolution 768P|1080P(10s 仅 768P)",
  },
  {
    id: "MiniMax-Hailuo-2.3-Fast",
    capabilities: { "video.generate": { textOnly: false, firstFrame: true } },
    lastVerified: "2026-08",
    note: "v1 i2v;duration 6|10;resolution 768P|1080P(10s 仅 768P)",
  },
  {
    id: "MiniMax-Hailuo-02",
    capabilities: {
      "video.generate": { textOnly: false, firstFrame: true, lastFrame: true },
    },
    lastVerified: "2026-08",
    note: "v1 t2v/i2v/fl2v;fl2v 不支持 512P;i2v resolution 512P|768P|1080P",
  },
  {
    id: "T2V-01-Director",
    capabilities: { "video.generate": { textOnly: true } },
    lastVerified: "2026-08",
    note: "v1 t2v;仅 720P/6s;prompt 支持运镜指令",
  },
  {
    id: "T2V-01",
    capabilities: { "video.generate": { textOnly: true } },
    lastVerified: "2026-08",
    note: "v1 t2v;仅 720P/6s",
  },
  {
    id: "I2V-01-Director",
    capabilities: { "video.generate": { textOnly: false, firstFrame: true } },
    lastVerified: "2026-08",
    note: "v1 i2v;仅 720P/6s;prompt 支持运镜指令",
  },
  {
    id: "I2V-01-live",
    capabilities: { "video.generate": { textOnly: false, firstFrame: true } },
    lastVerified: "2026-08",
    note: "v1 i2v;仅 720P/6s",
  },
  {
    id: "I2V-01",
    capabilities: { "video.generate": { textOnly: false, firstFrame: true } },
    lastVerified: "2026-08",
    note: "v1 i2v;仅 720P/6s",
  },
  {
    id: "S2V-01",
    capabilities: { "video.generate": {} },
    lastVerified: "2026-08",
    note: "v1 s2v;必传 subject_reference(单个 character);无 duration/resolution 入参",
  },
  {
    id: "image-01",
    capabilities: { "image.generate": { imageInput: true } },
    lastVerified: "2026-08",
    note: "图生图走 subject_reference;产物 url 有效期 24h",
  },
  {
    id: "image-01-live",
    capabilities: { "image.generate": { imageInput: true } },
    lastVerified: "2026-08",
    note: "支持 style 画风设置;产物 url 有效期 24h",
  },
]
