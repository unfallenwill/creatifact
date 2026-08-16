import type { ErrorCategory } from "../core/types"

interface ArkErrorBody {
  error?: { code?: string; message?: string }
}

// 错误码表:https://www.volcengine.com/docs/82379/1299023
const CODE_MAP: Array<[RegExp, ErrorCategory]> = [
  [/Authentication|AccessDenied|InvalidApiKey/i, "auth"],
  [/RateLimit|Throttling|ServerOverloaded/i, "rate"],
  [/QuotaExceeded|Arrears|AccountOverdue|Balance/i, "quota"],
  [/SensitiveContent|ContentFilter|审核|违规/i, "moderation"],
]

export function classifyArkError(status: number, body: unknown): ErrorCategory | undefined {
  if (status === 401 || status === 403) return "auth"
  if (status === 429) return "rate"
  if (status === 402) return "quota"

  const code = (body as ArkErrorBody | undefined)?.error?.code ?? ""
  if (code) {
    for (const [pattern, category] of CODE_MAP) {
      if (pattern.test(code)) return category
    }
  }
  if (status >= 500) return "internal"
  return undefined
}
