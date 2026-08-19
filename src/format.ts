/**
 * Minimal human-output formatting helpers. Zero-dependency table alignment —
 * a layout *framework* would be the wrong weight class for a handful of
 * listings, and stdout must stay stable for agents parsing piped output.
 */
import { createColors } from "picocolors"

/**
 * The CLI's color contract: colored on an interactive terminal, plain text
 * everywhere else. Built on picocolors' createColors instead of the default
 * export because the default's ambient heuristics (`!!env.CI`, win32) enable
 * color even when stdout is piped — which would leak ANSI escapes into agent
 * parsing inside CI runners. Explicit user forcing (FORCE_COLOR) still wins,
 * and NO_COLOR still disables everywhere.
 */
const colorEnabled =
  !process.env["NO_COLOR"] && (process.stdout.isTTY === true || !!process.env["FORCE_COLOR"])

/** The shared color instance; identity functions when color is disabled. */
export const pc = createColors(colorEnabled)

/** Strip ANSI escape sequences (SGR) from a string. */
export function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI needs the ESC literal
  return text.replace(/\x1b\[[0-9;]*m/g, "")
}

/** Visible width of a string (ANSI escape sequences are stripped). */
export function displayWidth(text: string): number {
  return stripAnsi(text).length
}
export function alignColumns(rows: string[][]): string[] {
  if (rows.length === 0) return []
  const width = Math.max(...rows.map((r) => r.length))
  const widths: number[] = []
  for (let col = 0; col < width; col++) {
    widths[col] = Math.max(...rows.map((r) => displayWidth((r[col] ?? "") as string)))
  }
  return rows.map((row) =>
    Array.from({ length: width }, (_, col) => {
      const cell = (row[col] ?? "") as string
      const colWidth = widths[col] ?? 0
      const pad = " ".repeat(colWidth - displayWidth(cell))
      return col === width - 1 ? cell : cell + pad
    }).join("  "),
  )
}

/**
 * Align rows into fixed columns: every column is padded to its widest cell,
 * columns joined by two spaces. Cells keep their exact text (color escape
 * sequences are NOT measured — pass pre-colored strings only if every cell in
 * that column carries identical decoration, or color after aligning).
 */

/** Clamp a string to max visible characters, appending an ellipsis. */
export function clampText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}
