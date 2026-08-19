import type { Capability, VerifiedModel } from "../core/types"

export const MINIMAX_DEFAULT_MODELS: Partial<Record<Capability, string>> = {
  "text.generate": "MiniMax-M2.7",
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
    id: "MiniMax-M3",
    capabilities: { "text.generate": {} },
    lastVerified: "2026-08",
    note: "flagship; coding/agentic SOTA, 1M context, multimodal; thinking configurable via options.thinking={type:adaptive|off} (default adaptive); max_completion_tokens recommended 131072, cap 524288",
  },
  {
    id: "MiniMax-M2.7",
    capabilities: { "text.generate": {} },
    lastVerified: "2026-08",
    note: "default text model; thinking cannot be disabled, content carries a leading inline <think> block (stripped by the CLI); max_completion_tokens recommended 65536, cap 204800",
  },
  {
    id: "MiniMax-M2.7-highspeed",
    capabilities: { "text.generate": {} },
    lastVerified: "2026-08",
    note: "M2.7 high-speed variant; thinking cannot be disabled",
  },
  {
    id: "MiniMax-M2.5",
    capabilities: { "text.generate": {} },
    lastVerified: "2026-08",
    note: "thinking cannot be disabled",
  },
  {
    id: "MiniMax-M2.5-highspeed",
    capabilities: { "text.generate": {} },
    lastVerified: "2026-08",
    note: "M2.5 high-speed variant; thinking cannot be disabled",
  },
  {
    id: "MiniMax-M2.1",
    capabilities: { "text.generate": {} },
    lastVerified: "2026-08",
    note: "thinking cannot be disabled",
  },
  {
    id: "MiniMax-M2.1-highspeed",
    capabilities: { "text.generate": {} },
    lastVerified: "2026-08",
    note: "M2.1 high-speed variant; thinking cannot be disabled",
  },
  {
    id: "MiniMax-M2",
    capabilities: { "text.generate": {} },
    lastVerified: "2026-08",
    note: "previous flagship; thinking cannot be disabled",
  },
  {
    id: "MiniMax-H3",
    capabilities: {
      "video.generate": {
        textOnly: false,
        firstFrame: true,
        lastFrame: true,
        // reference_image/reference_video/reference_audio (r2va) are mutually exclusive with first/last frames; not modeled yet
      },
    },
    lastVerified: "2026-08",
    note: "only model on the v2 endpoint; resolution 768P|2K; duration 4-15; ratio required for t2v and cannot be adaptive; last_frame must pair with first_frame",
  },
  {
    id: "MiniMax-Hailuo-2.3",
    capabilities: { "video.generate": { textOnly: false, firstFrame: true } },
    lastVerified: "2026-08",
    note: "v1 t2v/i2v; duration 6|10; resolution 768P|1080P (10s is 768P only)",
  },
  {
    id: "MiniMax-Hailuo-2.3-Fast",
    capabilities: { "video.generate": { textOnly: false, firstFrame: true } },
    lastVerified: "2026-08",
    note: "v1 i2v; duration 6|10; resolution 768P|1080P (10s is 768P only)",
  },
  {
    id: "MiniMax-Hailuo-02",
    capabilities: {
      "video.generate": { textOnly: false, firstFrame: true, lastFrame: true },
    },
    lastVerified: "2026-08",
    note: "v1 t2v/i2v/fl2v; fl2v has no 512P; i2v resolution 512P|768P|1080P",
  },
  {
    id: "T2V-01-Director",
    capabilities: { "video.generate": { textOnly: true } },
    lastVerified: "2026-08",
    note: "v1 t2v; 720P/6s only; prompt accepts camera-move directives",
  },
  {
    id: "T2V-01",
    capabilities: { "video.generate": { textOnly: true } },
    lastVerified: "2026-08",
    note: "v1 t2v; 720P/6s only",
  },
  {
    id: "I2V-01-Director",
    capabilities: { "video.generate": { textOnly: false, firstFrame: true } },
    lastVerified: "2026-08",
    note: "v1 i2v; 720P/6s only; prompt accepts camera-move directives",
  },
  {
    id: "I2V-01-live",
    capabilities: { "video.generate": { textOnly: false, firstFrame: true } },
    lastVerified: "2026-08",
    note: "v1 i2v; 720P/6s only",
  },
  {
    id: "I2V-01",
    capabilities: { "video.generate": { textOnly: false, firstFrame: true } },
    lastVerified: "2026-08",
    note: "v1 i2v; 720P/6s only",
  },
  {
    id: "S2V-01",
    capabilities: { "video.generate": {} },
    lastVerified: "2026-08",
    note: "v1 s2v; subject_reference required (single character); no duration/resolution params",
  },
  {
    id: "image-01",
    capabilities: { "image.generate": { imageInput: true } },
    lastVerified: "2026-08",
    note: "image-to-image via subject_reference; artifact url valid for 24h",
  },
  {
    id: "image-01-live",
    capabilities: { "image.generate": { imageInput: true } },
    lastVerified: "2026-08",
    note: "supports style presets; artifact url valid for 24h",
  },
]
