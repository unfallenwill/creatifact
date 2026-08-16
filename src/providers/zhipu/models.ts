import type { VerifiedModel } from "../core/types"

/**
 * 视频 oneOf 分支（请求体形状）与模型 ID 的映射。
 * https://docs.bigmodel.cn/api-reference/模型-api/视频生成异步
 */
export type ZhipuVideoMode =
  | "cogvideox3" // cogvideox-3:image_url 单图或 [首帧,尾帧] 数组
  | "cogvideox" // cogvideox-2 / cogvideox-flash:仅单图
  | "vidu-text" // viduq1-text:纯文生
  | "vidu-image" // viduq1-image / vidu2-image:单首帧图
  | "vidu-frames" // viduq1-start-end / vidu2-start-end:[首帧,尾帧]
  | "vidu-reference" // vidu2-reference:1-3 张参考图

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
    id: "cogvideox-3",
    capabilities: {
      "video.generate": { textOnly: false, firstFrame: true, lastFrame: true },
    },
    lastVerified: "2026-08",
    note: "image_url 单图=首帧,传 lastFrame 时自动变 [首帧,尾帧] 数组;size 最高 4K;fps 30|60;duration 5|10",
  },
  {
    id: "cogvideox-2",
    capabilities: { "video.generate": { textOnly: false, firstFrame: true } },
    lastVerified: "2026-08",
    note: "仅单图 image_url;无 duration/with_audio 入参",
  },
  {
    id: "cogvideox-flash",
    capabilities: { "video.generate": { textOnly: false, firstFrame: true } },
    lastVerified: "2026-08",
    note: "免费档;仅单图 image_url",
  },
  {
    id: "viduq1-text",
    capabilities: { "video.generate": { textOnly: true } },
    lastVerified: "2026-08",
    note: "纯文生;style general|anime;aspect_ratio 16:9|9:16|1:1;duration 5",
  },
  {
    id: "viduq1-image",
    capabilities: { "video.generate": { textOnly: false, firstFrame: true } },
    lastVerified: "2026-08",
    note: "单首帧图(png/jpeg/jpg/webp ≤50MB);duration 5;size 1920x1080",
  },
  {
    id: "vidu2-image",
    capabilities: { "video.generate": { textOnly: false, firstFrame: true } },
    lastVerified: "2026-08",
    note: "单首帧图;duration 4;size 1280x720;with_audio 仅 4s 支持",
  },
  {
    id: "viduq1-start-end",
    capabilities: {
      "video.generate": { textOnly: false, firstFrame: true, lastFrame: true },
    },
    lastVerified: "2026-08",
    note: "首尾帧两张图(分辨率比例需 0.8-1.25);duration 5;size 1920x1080",
  },
  {
    id: "vidu2-start-end",
    capabilities: {
      "video.generate": { textOnly: false, firstFrame: true, lastFrame: true },
    },
    lastVerified: "2026-08",
    note: "首尾帧两张图;duration 4;size 1280x720|480x360",
  },
  {
    id: "vidu2-reference",
    capabilities: { "video.generate": { textOnly: false, firstFrame: true } },
    lastVerified: "2026-08",
    note: "参考生视频:1-3 张参考图(firstFrame 映射为单元素数组,多图走 options.image_url);duration 4;aspect_ratio 16:9|9:16|1:1",
  },
  {
    id: "glm-image",
    capabilities: { "image.generate": {} },
    lastVerified: "2026-08",
    note: "同步 /images/generations 或异步 /async/images/generations(options.useAsync);仅 quality=hd;size 步进 32",
  },
  {
    id: "cogview-4-250304",
    capabilities: { "image.generate": {} },
    lastVerified: "2026-08",
    note: "同步图像生成;quality hd|standard;size 需被 16 整除",
  },
  {
    id: "cogview-4",
    capabilities: { "image.generate": {} },
    lastVerified: "2026-08",
    note: "同步图像生成;quality hd|standard",
  },
  {
    id: "cogview-3-flash",
    capabilities: { "image.generate": {} },
    lastVerified: "2026-08",
    note: "免费档同步图像生成",
  },
]
