/**
 * Minimal human-output formatting helpers. Zero-dependency table alignment —
 * a layout *framework* would be the wrong weight class for a handful of
 * listings, and stdout must stay stable for agents parsing piped output.
 */

/**
 * Align rows into fixed columns: every column is padded to its widest cell,
 * columns joined by two spaces. Cells keep their exact text (color escape
 * sequences are NOT measured — pass pre-colored strings only if every cell in
 * that column carries identical decoration, or color after aligning).
 */
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

/** Visible width of a string (ANSI escape sequences are stripped). */
export function displayWidth(text: string): number {
  // Measuring ANSI sequences requires the ESC literal in the regex.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI strip
  return text.replace(/\x1b\[[0-9;]*m/g, "").length
}

/** Clamp a string to max visible characters, appending an ellipsis. */
export function clampText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}
