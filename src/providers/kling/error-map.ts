import type { ErrorCategory } from "../core/types"

interface KlingErrorBody {
  error?: { message?: string; code?: number | string }
  message?: string
  code?: number
}

const MESSAGE_MAP: Array<[RegExp, ErrorCategory]> = [
  [/content moderation|sensitive|审核|违规|违禁|InvalidGeneratedContent/i, "moderation"],
  [/rate limit|too many request|Throttling/i, "rate"],
  [/quota|arrears|insufficient balance|余额/i, "quota"],
  [/api key|token|authentication|unauthorized|鉴权|认证/i, "auth"],
]

export function classifyKlingError(status: number, body: unknown): ErrorCategory | undefined {
  if (status === 401 || status === 403) return "auth"
  if (status === 429) return "rate"
  if (status >= 500) return "internal"

  const parsed = (body ?? {}) as KlingErrorBody
  const text = parsed.error?.message ?? parsed.message ?? ""
  for (const [pattern, category] of MESSAGE_MAP) {
    if (text && pattern.test(text)) return category
  }
  return undefined
}
