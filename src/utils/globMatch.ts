/**
 * Glob Pattern Matcher
 *
 * Lightweight glob matching supporting:
 * - * (single segment wildcard)
 * - ** (multi-segment wildcard)
 * - ? (single character)
 * - {a,b,c} (alternatives)
 * - [abc] / [!abc] (character classes)
 * - Brace expansion in path segments
 */

// ── Main Match Function ─────────────────────────────────────────────────────

export function globMatch(pattern: string, value: string): boolean {
  // Handle brace expansion first: {a,b,c} → match any of a, b, c
  const expanded = expandBraces(pattern)
  for (const p of expanded) {
    if (matchSinglePattern(p, value)) return true
  }
  return false
}

function matchSinglePattern(pattern: string, value: string): boolean {
  const regex = globToRegex(pattern)
  return regex.test(value)
}

// ── Brace Expansion ─────────────────────────────────────────────────────────

function expandBraces(pattern: string): string[] {
  const match = pattern.match(/^(.*?)\{([^{}]+)\}(.*)$/)
  if (!match) return [pattern]

  const [, prefix, optionsStr, suffix] = match
  const options = optionsStr.split(',').map(s => s.trim())

  const results: string[] = []
  for (const option of options) {
    const expanded = expandBraces(prefix + option + suffix)
    results.push(...expanded)
  }
  return results
}

// ── Glob to Regex ───────────────────────────────────────────────────────────

function globToRegex(pattern: string): RegExp {
  let regex = '^'
  let i = 0

  while (i < pattern.length) {
    const char = pattern[i]

    switch (char) {
      case '*':
        if (pattern[i + 1] === '*') {
          // ** — match everything including path separators
          regex += '.*'
          i += 2
          // Skip following slash if present (allow **/ to match zero dirs)
          if (pattern[i] === '/') i++
        } else {
          // * — match everything except path separator
          regex += '[^/]*'
          i++
        }
        break

      case '?':
        regex += '[^/]'
        i++
        break

      case '[': {
        // Character class
        const end = pattern.indexOf(']', i)
        if (end === -1) {
          regex += '\\['
          i++
        } else {
          let cls = pattern.slice(i + 1, end)
          if (cls.startsWith('!')) cls = '^' + cls.slice(1)
          regex += '[' + cls + ']'
          i = end + 1
        }
        break
      }

      case '{': {
        // Should have been expanded already, but handle inline
        const endBrace = pattern.indexOf('}', i)
        if (endBrace === -1) {
          regex += '\\{'
          i++
        } else {
          const options = pattern.slice(i + 1, endBrace).split(',').map(s => s.trim())
          regex += '(?:' + options.join('|') + ')'
          i = endBrace + 1
        }
        break
      }

      case '.':
      case '+':
      case '(':
      case ')':
      case '^':
      case '$':
      case '|':
      case '\\':
        regex += '\\' + char
        i++
        break

      default:
        regex += char
        i++
    }
  }

  regex += '$'
  return new RegExp(regex)
}

// ── Utility Functions ───────────────────────────────────────────────────────

export function globToRegexString(pattern: string): string {
  return globToRegex(pattern).source
}

export function isValidGlob(pattern: string): boolean {
  try {
    expandBraces(pattern).forEach(p => globToRegex(p))
    return true
  } catch {
    return false
  }
}

export function extractGlobBase(pattern: string): { base: string; rest: string } {
  // Find the first wildcard
  const wildcardIdx = pattern.search(/[*?[{]/)
  if (wildcardIdx === -1) return { base: pattern, rest: '' }

  // Find the last / before the wildcard
  const lastSlash = pattern.lastIndexOf('/', wildcardIdx)
  if (lastSlash === -1) return { base: '', rest: pattern }

  return {
    base: pattern.slice(0, lastSlash),
    rest: pattern.slice(lastSlash + 1),
  }
}
