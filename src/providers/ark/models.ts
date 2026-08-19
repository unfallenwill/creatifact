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
    note: "text chat; verify the endpoint/model enabled in the Ark console",
  },
  {
    id: "doubao-1-5-pro-32k-250115",
    capabilities: { "text.generate": {} },
    lastVerified: "2026-08",
    note: "cost-efficient text chat",
  },
  {
    id: "doubao-seedance-1-0-pro-250528",
    capabilities: {
      "video.generate": { textOnly: false, firstFrame: true, lastFrame: false },
    },
    lastVerified: "2026-08",
    note: "official sample id; verify the endpoint/model enabled in the Ark console before use",
  },
  {
    id: "doubao-seedance-2.0",
    capabilities: {
      "video.generate": { textOnly: false, firstFrame: true, lastFrame: true },
    },
    lastVerified: "2026-08",
    note: "also supports the reference_image role (2.0/2.5)",
  },
  {
    id: "doubao-seedream-4.0-250828",
    capabilities: { "image.generate": { imageInput: true } },
    lastVerified: "2026-08",
    note: "with an image input it becomes image-to-image / editing",
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
    note: "text endpoint takes no dimensions; multimodal dimensions live at /embeddings/multimodal",
  },
]
