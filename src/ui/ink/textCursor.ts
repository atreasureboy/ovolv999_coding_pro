/**
 * UTF-16-safe cursor stepping for text editors. `cursor` positions in the
 * composer are string indices; naive ±1 steps land mid-surrogate-pair on
 * astral-plane input (emoji, CJK ext), splitting the pair on backspace and
 * rendering a lone surrogate in the cursor cell. These helpers move by a
 * whole code point while keeping the code-unit index space.
 */
export function prevCursor(text: string, pos: number): number {
  if (pos <= 0) return 0
  if (pos >= 2) {
    const hi = text.charCodeAt(pos - 2)
    const lo = text.charCodeAt(pos - 1)
    if (hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) return pos - 2
  }
  return pos - 1
}

export function nextCursor(text: string, pos: number): number {
  if (pos >= text.length) return text.length
  if (pos + 1 < text.length) {
    const hi = text.charCodeAt(pos)
    const lo = text.charCodeAt(pos + 1)
    if (hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) return pos + 2
  }
  return pos + 1
}
