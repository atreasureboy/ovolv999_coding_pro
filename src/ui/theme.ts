/**
 * UI Theme — the single source of truth for every color the TUI uses.
 *
 * Round 44: before this file existed, 18 ad-hoc color strings (hex
 * literals, named colors, bright variants) were scattered across the
 * components — visually loud on dark terminals and impossible to tune.
 * The token set mirrors opencode's theme schema (primary/accent/text/
 * textMuted/border/diff roles…) with values sampled from its official
 * dark palette: restrained foreground accents, wide muted range, and
 * soft diff backgrounds instead of saturated greens/reds.
 *
 * Rules for component authors:
 *   - NEVER hardcode a color; import `t` and use a semantic role.
 *   - bright variants are reserved for flags that must pop (warnings
 *     while streaming); everything else stays calm.
 */

// ── Core palette (sampled from opencode's dark steps) ──────────────────────

const C = {
  /** Foreground text. */
  text: '#eeeeee',
  /** Secondary text — labels, key hints, less-important rows. */
  muted: '#808080',
  /** Faint — separators, timestamps, rules. */
  faint: '#5a5a5a',
  /** Primary interactive accent (warm orange — selections, active states). */
  primary: '#fab283',
  /** Brand/violet accent (logo, headings, mode chips). */
  accent: '#9d7cd8',
  /** Cool info tone — model/context metadata. */
  info: '#8fa8d8',
  error: '#e06c75',
  warning: '#e5c07b',
  success: '#7fd88f',

  /** Panels & chrome. */
  borderSubtle: '#3a3a3a',
  borderActive: '#6a6a6a',

  /** Diff roles — muted backgrounds + readable foregrounds. */
  diffAddedFg: '#7fd88f',
  diffRemovedFg: '#e06c75',
  diffAddedBg: '#1c2b23',
  diffRemovedBg: '#2f2024',
  diffHunkHeader: '#828bb8',
  diffLineNumber: '#8f8f8f',

  /** Syntax highlighting (code blocks). */
  syntaxComment: '#7a7a7a',
  syntaxKeyword: '#c58fe0',
  syntaxFunction: '#61afef',
  syntaxString: '#98c379',
  syntaxNumber: '#d19a66',
} as const

export const t = {
  // text roles
  text: C.text,
  textStrong: (s: string) => s, // marker only; bold handled at call site
  muted: C.muted,
  faint: C.faint,

  // accents
  primary: C.primary,
  accent: C.accent,
  info: C.info,

  // status
  error: C.error,
  warning: C.warning,
  success: C.success,

  // chrome
  border: C.borderSubtle,
  borderActive: C.borderActive,

  // diff
  diffAdded: C.diffAddedFg,
  diffRemoved: C.diffRemovedFg,
  diffAddedBg: C.diffAddedBg,
  diffRemovedBg: C.diffRemovedBg,
  diffHunkHeader: C.diffHunkHeader,
  diffLineNumber: C.diffLineNumber,

  // syntax
  syntaxComment: C.syntaxComment,
  syntaxKeyword: C.syntaxKeyword,
  syntaxFunction: C.syntaxFunction,
  syntaxString: C.syntaxString,
  syntaxNumber: C.syntaxNumber,
} as const

export type ThemeTokens = typeof t

/**
 * Map our tokens to Ink's named colors where components expect
 * `color={...}` strings; hex passes through fine in modern Ink, so the
 * tokens are used directly.
 */

/** Context-pressure scale shared by StatusBar and compaction notices. */
export function pressureColor(pct: number): string {
  if (pct > 0.8) return t.error
  if (pct > 0.5) return t.warning
  return t.success
}
