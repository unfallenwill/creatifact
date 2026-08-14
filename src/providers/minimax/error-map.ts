import type { ErrorCategory } from "../core/types"

interface MiniMaxErrorBody {
  base_resp?: { status_code?: number; status_msg?: string }
  error?: { message?: string }
}

const STATUS_MAP: Array<[RegExp, ErrorCategory]> = [
  [/sensitive|content.*filter|审核|违规/i, "moderation"],
  [/rate.?limit|too many|Throttling/i, "rate"],
  [/quota|arrears|balance|余额/i, "quota"],
  [/api.?key|token|auth|unauthorized/i, "auth"],
]

// 状态码含义:https://platform.minimaxi.com/docs/api-reference/errorcode.md
function fromStatusCode(code: number): ErrorCategory | undefined {
  if (code === 1004 || code === 2049) return "auth"
  if (code === 1002) return "rate"
  if (code === 1008) return "quota"
  // 1026 输入涉敏 / 1027 输出涉敏
  if (code === 1026 || code === 1027) return "moderation"
  return undefined
}

export function classifyMinimaxError(status: number, body: unknown): ErrorCategory | undefined {
  if (status === 401 || status === 403) return "auth"
  if (status === 429) return "rate"
  if (status === 402) return "quota"
  if (status >= 500) return "internal"

  const parsed = (body ?? {}) as MiniMaxErrorBody
  const code = parsed.base_resp?.status_code
  if (typeof code === "number") {
    const byCode = fromStatusCode(code)
    if (byCode) return byCode
  }

  const text = parsed.base_resp?.status_msg ?? parsed.error?.message ?? ""
  for (const [pattern, category] of STATUS_MAP) {
    if (text && pattern.test(text)) return category
  }
  return undefined
}
