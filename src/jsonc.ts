/**
 * Strip JSONC (comments and trailing commas) from text so plain JSON.parse
 * can consume it. String-aware: `//`, `/*` and commas inside string values —
 * URLs and glob-ish text are everywhere in prompts — pass through untouched.
 * Stripped characters become spaces and newlines are preserved, so JSON.parse
 * error positions stay true to the original file.
 */
export function stripJsonc(text: string): string {
  return stripTrailingCommas(stripComments(text))
}

/** Index just past the string literal starting at text[start] (its opening quote). */
function endOfString(text: string, start: number): number {
  const n = text.length
  let j = start + 1
  while (j < n && text[j] !== '"') {
    j += text[j] === "\\" ? 2 : 1
  }
  return Math.min(j + 1, n)
}

const JSON_WS = " \t\n\r"

/** What a construct is replaced by, and where scanning resumes. */
interface Span {
  replacement: string
  next: number
}

/** A line comment becomes spaces up to (not including) its newline. */
function lineCommentSpan(text: string, start: number): Span {
  let replacement = "  "
  let i = start + 2
  while (i < text.length && text[i] !== "\n") {
    replacement += " "
    i++
  }
  return { replacement, next: i }
}

/** A block comment becomes spaces with its newlines kept (line-position fidelity). */
function blockCommentSpan(text: string, start: number): Span {
  let replacement = "  "
  let i = start + 2
  while (i < text.length && (text[i] !== "*" || text[i + 1] !== "/")) {
    replacement += text[i] === "\n" ? "\n" : " "
    i++
  }
  return { replacement: `${replacement}  `, next: Math.min(i + 2, text.length) }
}

/** Remove line (//) and block comments outside string literals. */
function stripComments(text: string): string {
  let out = ""
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    if (c === '"') {
      const end = endOfString(text, i)
      out += text.slice(i, end)
      i = end
    } else if (c === "/" && text[i + 1] === "/") {
      const span = lineCommentSpan(text, i)
      out += span.replacement
      i = span.next
    } else if (c === "/" && text[i + 1] === "*") {
      const span = blockCommentSpan(text, i)
      out += span.replacement
      i = span.next
    } else {
      out += c
      i++
    }
  }
  return out
}

/** Remove commas whose next non-whitespace character closes an object or array. */
function stripTrailingCommas(text: string): string {
  let out = ""
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    if (c === '"') {
      const end = endOfString(text, i)
      out += text.slice(i, end)
      i = end
      continue
    }
    if (c === "," && closesAfterWhitespace(text, i)) {
      out += " "
      i++
      continue
    }
    out += c
    i++
  }
  return out
}

/** True when the only thing between the comma at text[i] and the next } or ] is whitespace. */
function closesAfterWhitespace(text: string, i: number): boolean {
  let j = i + 1
  while (j < text.length && JSON_WS.includes(text[j] ?? "")) {
    j++
  }
  return text[j] === "}" || text[j] === "]"
}
