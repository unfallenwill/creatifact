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

// Status code meanings: https://platform.minimaxi.com/docs/api-reference/errorcode.md
function fromStatusCode(code: number): ErrorCategory | undefined {
  if (code === 1004 || code === 2049) return "auth"
  if (code === 1002) return "rate"
  if (code === 1008) return "quota"
  // 1026 sensitive input / 1027 sensitive output / 2013 invalid params (caller error; do not retry)
  if (code === 1026 || code === 1027) return "moderation"
  if (code === 2013) return "invalid"
  return undefined
}

// OpenAI-style errors embed the business code at the message tail, e.g. "... (2013)"
const TRAILING_CODE_RE = /\((\d{4})\)\s*$/

function fromHttpStatus(status: number): ErrorCategory | undefined {
  if (status === 401 || status === 403) return "auth"
  if (status === 429) return "rate"
  if (status === 402) return "quota"
  if (status >= 500) return "internal"
  return undefined
}

/** base_resp.status_code → embedded tail code → message regex, cascading fallbacks. */
function fromBody(body: unknown): ErrorCategory | undefined {
  const parsed = (body ?? {}) as MiniMaxErrorBody
  const code = parsed.base_resp?.status_code
  if (typeof code === "number") {
    const byCode = fromStatusCode(code)
    if (byCode) return byCode
  }

  const text = parsed.base_resp?.status_msg ?? parsed.error?.message ?? ""

  // Embedded business codes take priority over regex so "token" inside "TokenPlan" never misfires as auth
  const embedded = TRAILING_CODE_RE.exec(text)
  if (embedded) {
    const byCode = fromStatusCode(Number(embedded[1]))
    if (byCode) return byCode
  }

  for (const [pattern, category] of STATUS_MAP) {
    if (text && pattern.test(text)) return category
  }
  return undefined
}

export function classifyMinimaxError(status: number, body: unknown): ErrorCategory | undefined {
  return fromHttpStatus(status) ?? fromBody(body)
}
