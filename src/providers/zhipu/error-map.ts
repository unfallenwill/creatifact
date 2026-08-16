import type { ErrorCategory } from "../core/types"

interface ZhipuErrorBody {
  error?: { code?: string | number; message?: string }
}

// 业务错误码含义:https://docs.bigmodel.cn/cn/api/api-code.md
// (HTTP 状态码仅是外层包装,内层 error.code 才是权威分类)
const CODE_MAP: Record<string, ErrorCategory> = {
  // 401 身份验证类
  "1000": "auth",
  "1001": "auth",
  "1003": "auth",
  "1005": "auth",
  // 403 无权访问
  "1220": "auth",
  // 429 账户欠费/限额类(平台侧配额)
  "1113": "quota",
  // 400 参数/模型错误(调用方问题,不应重试)
  "1210": "invalid",
  "1211": "invalid",
  "1212": "invalid",
  "1213": "invalid",
  "1214": "invalid",
  "1215": "invalid",
  "1221": "invalid",
  "1222": "invalid",
  "1261": "invalid",
  // 400 内容安全
  "1301": "moderation",
}

// 429 限流族(1302-1321 都以 429 返回)
function isRateCode(code: string): boolean {
  return code === "1302" || code === "1305" || (Number(code) >= 1308 && Number(code) <= 1321)
}

const MESSAGE_MAP: Array<[RegExp, ErrorCategory]> = [
  [/敏感|不安全|content.?filter|moderation|sensitive/i, "moderation"],
  [/速率|频率|访问量过大|rate.?limit|too many/i, "rate"],
  [/欠费|余额|充值|arrears|balance|quota/i, "quota"],
  [/身份验证|鉴权|api.?key|token|authentication|unauthorized/i, "auth"],
]

/** error.code(字符串业务码)→分类;429 限流族单独判断。 */
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

/** 智谱错误分类:error.code(字符串业务码)优先,其次 HTTP 状态,最后消息正则兜底。 */
export function classifyZhipuError(status: number, body: unknown): ErrorCategory | undefined {
  const byCode = fromBusinessCode(body)
  if (byCode) return byCode

  if (status === 401 || status === 403) return "auth"
  if (status === 429) return "rate"
  if (status >= 500) return "internal"

  return fromMessage(body)
}
