/**
 * ANSI Terminal Utilities
 *
 * ANSI escape codes, color manipulation, text formatting.
 */

// ── ANSI Codes ──────────────────────────────────────────────────────────────

export const ANSI = {
  RESET: '\x1b[0m',
  BOLD: '\x1b[1m',
  DIM: '\x1b[2m',
  ITALIC: '\x1b[3m',
  UNDERLINE: '\x1b[4m',
  BLINK: '\x1b[5m',
  INVERSE: '\x1b[7m',
  HIDDEN: '\x1b[8m',
  STRIKETHROUGH: '\x1b[9m',

  // Foreground colors
  BLACK: '\x1b[30m',
  RED: '\x1b[31m',
  GREEN: '\x1b[32m',
  YELLOW: '\x1b[33m',
  BLUE: '\x1b[34m',
  MAGENTA: '\x1b[35m',
  CYAN: '\x1b[36m',
  WHITE: '\x1b[37m',
  GRAY: '\x1b[90m',
  BRIGHT_RED: '\x1b[91m',
  BRIGHT_GREEN: '\x1b[92m',
  BRIGHT_YELLOW: '\x1b[93m',
  BRIGHT_BLUE: '\x1b[94m',
  BRIGHT_MAGENTA: '\x1b[95m',
  BRIGHT_CYAN: '\x1b[96m',
  BRIGHT_WHITE: '\x1b[97m',

  // Background colors
  BG_BLACK: '\x1b[40m',
  BG_RED: '\x1b[41m',
  BG_GREEN: '\x1b[42m',
  BG_YELLOW: '\x1b[43m',
  BG_BLUE: '\x1b[44m',
  BG_MAGENTA: '\x1b[45m',
  BG_CYAN: '\x1b[46m',
  BG_WHITE: '\x1b[47m',
} as const

// ── 256-color ───────────────────────────────────────────────────────────────

export function fg256(n: number): string {
  return `\x1b[38;5;${n}m`
}

export function bg256(n: number): string {
  return `\x1b[48;5;${n}m`
}

// ── TrueColor (24-bit) ──────────────────────────────────────────────────────

export function fgRGB(hex: string): string {
  const { r, g, b } = hexToRgb(hex)
  return `\x1b[38;2;${r};${g};${b}m`
}

export function bgRGB(hex: string): string {
  const { r, g, b } = hexToRgb(hex)
  return `\x1b[48;2;${r};${g};${b}m`
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const cleaned = hex.replace('#', '')
  const r = parseInt(cleaned.slice(0, 2), 16)
  const g = parseInt(cleaned.slice(2, 4), 16)
  const b = parseInt(cleaned.slice(4, 6), 16)
  return { r, g, b }
}

// ── Text Wrappers ───────────────────────────────────────────────────────────

export function colorize(text: string, ...colors: string[]): string {
  return colors.join('') + text + ANSI.RESET
}

export function bold(text: string): string {
  return ANSI.BOLD + text + ANSI.RESET
}

export function dim(text: string): string {
  return ANSI.DIM + text + ANSI.RESET
}

export function italic(text: string): string {
  return ANSI.ITALIC + text + ANSI.RESET
}

export function underline(text: string): string {
  return ANSI.UNDERLINE + text + ANSI.RESET
}

export function strikethrough(text: string): string {
  return ANSI.STRIKETHROUGH + text + ANSI.RESET
}

export function red(text: string): string { return colorize(text, ANSI.RED) }
export function green(text: string): string { return colorize(text, ANSI.GREEN) }
export function yellow(text: string): string { return colorize(text, ANSI.YELLOW) }
export function blue(text: string): string { return colorize(text, ANSI.BLUE) }
export function magenta(text: string): string { return colorize(text, ANSI.MAGENTA) }
export function cyan(text: string): string { return colorize(text, ANSI.CYAN) }
export function gray(text: string): string { return colorize(text, ANSI.GRAY) }
export function white(text: string): string { return colorize(text, ANSI.WHITE) }

// ── Strip ANSI ──────────────────────────────────────────────────────────────

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

export function ansiLength(text: string): number {
  return stripAnsi(text).length
}

// ── Cursor & Screen ─────────────────────────────────────────────────────────

export const CURSOR = {
  HIDE: '\x1b[?25l',
  SHOW: '\x1b[?25h',
  UP: (n: number) => `\x1b[${n}A`,
  DOWN: (n: number) => `\x1b[${n}B`,
  RIGHT: (n: number) => `\x1b[${n}C`,
  LEFT: (n: number) => `\x1b[${n}D`,
  TO: (row: number, col: number) => `\x1b[${row};${col}H`,
  SAVE: '\x1b7',
  RESTORE: '\x1b8',
  CLEAR_LINE: '\x1b[2K',
  CLEAR_SCREEN: '\x1b[2J',
  CLEAR_BELOW: '\x1b[J',
  CLEAR_ABOVE: '\x1b[1J',
}

// ── Progress Bar ────────────────────────────────────────────────────────────

export function progressBar(
  ratio: number,
  width = 20,
  fill = '█',
  empty = '░',
): string {
  const clamped = Math.min(1, Math.max(0, ratio))
  const filled = Math.round(clamped * width)
  return fill.repeat(filled) + empty.repeat(width - filled)
}

// ── Padding & Truncation ────────────────────────────────────────────────────

export function padRight(text: string, width: number, pad = ' '): string {
  const len = ansiLength(text)
  if (len >= width) return text
  return text + pad.repeat(width - len)
}

export function padLeft(text: string, width: number, pad = ' '): string {
  const len = ansiLength(text)
  if (len >= width) return text
  return pad.repeat(width - len) + text
}

export function center(text: string, width: number, pad = ' '): string {
  const len = ansiLength(text)
  if (len >= width) return text
  const total = width - len
  const left = Math.floor(total / 2)
  const right = total - left
  return pad.repeat(left) + text + pad.repeat(right)
}

export function truncate(text: string, maxWidth: number, suffix = '…'): string {
  const len = ansiLength(text)
  if (len <= maxWidth) return text
  const keep = maxWidth - ansiLength(suffix)
  return text.slice(0, keep) + suffix
}

export function truncateAnsi(text: string, maxWidth: number, suffix = '…'): string {
  const stripped = stripAnsi(text)
  if (stripped.length <= maxWidth) return text
  return truncate(stripped, maxWidth, suffix)
}

// ── Box Drawing ─────────────────────────────────────────────────────────────

export function box(text: string, options: { padding?: number; title?: string } = {}): string {
  const { padding = 1, title } = options
  const lines = text.split('\n')
  const maxLen = Math.max(...lines.map(l => ansiLength(l))) + padding * 2
  const horizontal = '─'.repeat(maxLen)
  const pad = ' '.repeat(padding)

  const result: string[] = []
  if (title) {
    const titleStr = ` ${title} `
    const titleLine = '┌' + titleStr + '─'.repeat(Math.max(0, maxLen - titleStr.length)) + '┐'
    result.push(titleLine)
  } else {
    result.push('┌' + horizontal + '┐')
  }

  for (const line of lines) {
    const padded = pad + padRight(line, maxLen - padding * 2) + pad
    result.push('│' + padded + '│')
  }

  result.push('└' + horizontal + '┘')
  return result.join('\n')
}

// ── Link ────────────────────────────────────────────────────────────────────

export function hyperlink(text: string, url: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`
}

// ── Detect Color Support ────────────────────────────────────────────────────

export function getColorSupport(): 'truecolor' | '256' | 'basic' | 'none' {
  const term = process.env.TERM ?? ''
  const colorterm = process.env.COLORTERM ?? ''

  if (colorterm === 'truecolor' || colorterm === '24bit') return 'truecolor'
  if (term.includes('256')) return '256'
  if (term.includes('color')) return 'basic'
  if (!term || term === 'dumb') return 'none'
  return 'basic'
}

export function supportsHyperlinks(): boolean {
  const termProgram = process.env.TERM_PROGRAM ?? ''
  return ['WezTerm', 'iTerm.app', 'vscode', 'Hyper'].includes(termProgram)
}
