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
 *
 * Round 41 audit fix: trailing-comma removal is STRING-AWARE — the old
 * post-hoc regex `,/s*[}\]]` ran over the whole document and silently
 * rewrote `, }` / `,]` sequences INSIDE string values (regex payloads,
 * shell commands). The scanner now buffers each top-level comma and only
 * emits it when the next significant character proves it isn't trailing.
 */
export function stripJsonc(text: string): string {
  let out = ''
  let i = 0
  let inString = false
  /** A comma outside a string, awaiting its verdict (trailing or not). */
  let pendingComma = false
  const n = text.length

  /** Emit a buffered comma iff it turned out NOT to be trailing. */
  const flushComma = (): void => {
    if (pendingComma) {
      out += ','
      pendingComma = false
    }
  }

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
      flushComma()
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
    if (ch === ',') {
      // Hold the comma: emit only if a significant (non-ws) char follows.
      // A '}' / ']' next means it was trailing → dropped.
      pendingComma = true
      i++
      continue
    }
    if (ch === '}' || ch === ']') {
      // Dangling comma before this closer was trailing — drop it.
      pendingComma = false
      out += ch
      i++
      continue
    }
    if (/\s/.test(ch)) {
      // Whitespace (and comment-derived newlines) passes through
      // unchanged while the comma verdict stays pending.
      out += ch
      i++
      continue
    }
    flushComma()
    out += ch
    i++
  }
  if (inString) {
    throw new SyntaxError('Unterminated string literal in JSONC input')
  }
  return out
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
