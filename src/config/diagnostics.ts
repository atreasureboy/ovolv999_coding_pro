/**
 * Config diagnostics — structured, visible config problems.
 *
 * v0.4.1 golden-path contract: config errors are NEVER silent. A corrupt
 * settings file degrades to defaults WITH a one-time stderr warning that
 * names the file, the location, and the fix. An explicit settings load
 * (the interactive REPL) still throws a structured error carrying
 * line/column. Warnings go to stderr only — stdout is reserved for program
 * output (the --pipe contract).
 *
 * Validation is hand-rolled (project convention — zod has zero runtime
 * imports in src/; see magicDocs.ts which only regex-detects user schemas).
 */

import { warnOnce } from '../utils/warnOnce.js'

export interface ConfigDiagnostic {
  /** Absolute path of the offending file. */
  file: string
  /** 1-based line, when known. */
  line?: number
  /** 1-based column, when known. */
  column?: number
  /** Dotted field path (e.g. "permissions.rules[2]", "permissions.mode"). */
  field?: string
  severity: 'error' | 'warning'
  message: string
  /** Actionable fix suggestion. */
  fix?: string
}

/**
 * Extract line/column from a JSON.parse SyntaxError.
 *
 * V8 message formats across Node versions:
 *   - newest: "Unexpected token '}', \"...\" is not valid JSON"      (no location)
 *   - older:  "Unexpected token } in JSON at position 12"           (offset only)
 *   - newer:  "... at position 12 (line 3 column 5)"                (explicit)
 *
 * When only an offset is available and the source text is provided, the
 * offset is converted to line/column. Returns null for non-SyntaxErrors,
 * or an empty object when the error is a JSON syntax error but no
 * location can be determined.
 */
export function parseJsonSyntaxError(
  err: unknown,
  source?: string,
): { line?: number; column?: number } | null {
  if (!(err instanceof SyntaxError)) return null
  const msg = err.message

  const explicit = msg.match(/\(line (\d+) column (\d+)\)/)
  if (explicit) return { line: Number(explicit[1]), column: Number(explicit[2]) }

  const posMatch = msg.match(/at position (\d+)/)
  if (posMatch && source !== undefined) {
    const pos = Number(posMatch[1])
    let line = 1
    let column = 1
    for (let i = 0; i < pos && i < source.length; i++) {
      if (source[i] === '\n') {
        line++
        column = 1
      } else {
        column++
      }
    }
    return { line, column }
  }

  return {}
}

/** Render a location suffix like ":12:5" (or "" when unknown). */
function locationSuffix(diag: Pick<ConfigDiagnostic, 'line' | 'column'>): string {
  if (diag.line === undefined) return ''
  return diag.column !== undefined ? `:${diag.line}:${diag.column}` : `:${diag.line}`
}

/**
 * Render diagnostics as human-readable lines (one per diagnostic).
 * Used both for the one-line stderr warnings and for structured error
 * detail blocks.
 */
export function formatDiagnostics(diags: ConfigDiagnostic[]): string {
  return diags
    .map((d) => {
      const loc = locationSuffix(d)
      const field = d.field ? ` (${d.field})` : ''
      const fix = d.fix ? ` — fix: ${d.fix}` : ''
      return `[config ${d.severity}] ${d.file}${loc}${field}: ${d.message}${fix}`
    })
    .join('\n')
}

/**
 * Warn about a diagnostic exactly once per (file, field-or-message).
 * stderr only — never stdout.
 */
export function warnConfigOnce(diag: ConfigDiagnostic): void {
  const key = `${diag.file}::${diag.field ?? diag.message}`
  warnOnce(key, formatDiagnostics([diag]))
}
