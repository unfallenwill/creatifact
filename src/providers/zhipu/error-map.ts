import type { ErrorCategory } from "../core/types"

interface ZhipuErrorBody {
  error?: { code?: string | number; message?: string }
}

// Business error codes: https://docs.bigmodel.cn/cn/api/api-code.md
// (the HTTP status is just an outer envelope; the inner error.code is the authoritative classification)
const CODE_MAP: Record<string, ErrorCategory> = {
  // 401 authentication family
  "1000": "auth",
  "1001": "auth",
  "1003": "auth",
  "1005": "auth",
  // 403 access denied
  "1220": "auth",
  // 429 account arrears / platform-side quota family
  "1113": "quota",
  // 400 invalid params/model (caller error; do not retry)
  "1210": "invalid",
  "1211": "invalid",
  "1212": "invalid",
  "1213": "invalid",
  "1214": "invalid",
  "1215": "invalid",
  "1221": "invalid",
  "1222": "invalid",
  "1261": "invalid",
  // 400 content safety
  "1301": "moderation",
}

// 429 rate-limit family (1302-1321 all return as 429)
function isRateCode(code: string): boolean {
  return code === "1302" || code === "1305" || (Number(code) >= 1308 && Number(code) <= 1321)
}

const MESSAGE_MAP: Array<[RegExp, ErrorCategory]> = [
  [/敏感|不安全|content.?filter|moderation|sensitive/i, "moderation"],
  [/速率|频率|访问量过大|rate.?limit|too many/i, "rate"],
  [/欠费|余额|充值|arrears|balance|quota/i, "quota"],
  [/身份验证|鉴权|api.?key|token|authentication|unauthorized/i, "auth"],
]

/** error.code (string business code) → category; the 429 rate-limit family is judged separately. */
function fromBusinessCode(body: unknown): ErrorCategory | undefined {
  const parsed = (body ?? {}) as ZhipuErrorBody
  const code = parsed.error?.code
  if (code === undefined || code === null || `${code}` === "") return undefined
  const key = `${code}`
  return CODE_MAP[key] ?? (isRateCode(key) ? "rate" : undefined)
}

function fromMessage(body: unknown): ErrorCategory | undefined {
  const parsed = (body ?? {}) as ZhipuErrorBody
  const text = parsed.error?.message ?? ""
  for (const [pattern, category] of MESSAGE_MAP) {
    if (text && pattern.test(text)) return category
  }
  return undefined
}

/** Zhipu error classification: error.code (string business code) first, then HTTP status, then message regex fallback. */
export function classifyZhipuError(status: number, body: unknown): ErrorCategory | undefined {
  const byCode = fromBusinessCode(body)
  if (byCode) return byCode

  if (status === 401 || status === 403) return "auth"
  if (status === 429) return "rate"
  if (status >= 500) return "internal"

  return fromMessage(body)
}
