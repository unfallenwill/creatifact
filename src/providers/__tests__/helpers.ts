export interface Recorded {
  url: string
  init: RequestInit | undefined
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

export function mockFetch(responses: Array<(r: Recorded) => Response | Promise<Response>>) {
  const recorded: Recorded[] = []
  const original = globalThis.fetch
  let call = 0
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    recorded.push({ url: String(url), init })
    const responder = responses[Math.min(call, responses.length - 1)]
    if (!responder) throw new Error(`no mock response for call ${call}`)
    const target = recorded[recorded.length - 1]
    if (!target) throw new Error("recording failed")
    call++
    return responder(target)
  }) as typeof fetch
  return {
    recorded,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

export function at(recorded: Recorded[], i: number): Recorded {
  const r = recorded[i]
  if (!r) throw new Error(`missing recorded call ${i}`)
  return r
}

export function bodyOf(r: Recorded): Record<string, unknown> {
  return JSON.parse(String(r.init?.body)) as Record<string, unknown>
}

/** Lowercased header record: the JSON client sends a plain object, the OpenAI SDK a Headers instance. */
export function headersOf(r: Recorded): Record<string, string> {
  const headers = r.init?.headers
  const entries =
    headers instanceof Headers
      ? [...headers.entries()]
      : Object.entries((headers ?? {}) as Record<string, string>)
  return Object.fromEntries(entries.map(([k, v]) => [k.toLowerCase(), v]))
}
