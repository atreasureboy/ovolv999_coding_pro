/**
 * JSONC — JSON with comments and trailing commas (opencode/codex config
 * style). Settings files accept:
 *   - // line comments and /* block comments *\/ (outside string literals)
 *   - trailing commas before } or ]
 *
 * Implementation strips comments to produce plain JSON, then delegates
 * to JSON.parse so error reporting and parsing semantics stay native.
 * Strings are preserved verbatim — comment markers inside quotes are not
 * comments.
 */

/**
 * Strip JSONC extensions from `text`, returning valid JSON.
 * Throws SyntaxError when a string literal or block comment is unterminated.
 */
export function stripJsonc(text: string): string {
  let out = ''
  let i = 0
  let inString = false
  const n = text.length

  while (i < n) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (ch === '\\') {
        // Preserve escaped sequence verbatim (e.g. \" inside a string).
        const next = text[i + 1]
        if (next !== undefined) {
          out += next
          i += 2
          continue
        }
      }
      if (ch === '"') inString = false
      i++
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      i++
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end < 0) {
        throw new SyntaxError('Unterminated block comment in JSONC input')
      }
      // Keep newlines inside block comments so line numbers in later
      // parse errors stay close to the original file.
      const skipped = text.slice(i, end)
      for (const c of skipped) {
        if (c === '\n') out += '\n'
      }
      i = end + 2
      continue
    }
    out += ch
    i++
  }
  if (inString) {
    throw new SyntaxError('Unterminated string literal in JSONC input')
  }
  // Trailing commas: valid JSONC, invalid JSON. Remove commas whose next
  // non-whitespace character closes an object/array.
  return out.replace(/,(\s*[}\]])/g, '$1')
}

/**
 * Parse JSON or JSONC. Plain JSON is parsed directly; when that fails the
 * JSONC-stripped form is attempted. Throws the ORIGINAL JSON.parse error
 * when both fail, so messages keep pointing at the real syntax problem.
 */
export function parseJsonc<T = unknown>(text: string): T {
  try {
    return JSON.parse(text) as T
  } catch (jsonErr) {
    let stripped: string
    try {
      stripped = stripJsonc(text)
    } catch {
      throw jsonErr
    }
    try {
      return JSON.parse(stripped) as T
    } catch {
      throw jsonErr
    }
  }
}
