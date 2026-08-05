/**
 * Live slash-command suggester.
 *
 * Renders a filtered list of commands + skills below the prompt as the user
 * types after `/`. Lives below readline's prompt (which is rendered ON the
 * line we don't control) so we must:
 *   1. Move down one line (under the prompt)
 *   2. Clear any previously rendered lines
 *   3. Print the current match list
 *   4. Move the cursor back up to where readline expects it
 *
 * Tab completion is wired separately via a `completer` passed to
 * `readline.createInterface`. Tab completes only the command name (not args)
 * which matches Claude Code's behavior.
 *
 * Both pieces are gated by `enabled` (default: TTY only). Non-TTY (piped /
 * CI) gets nothing — the old "Did you mean?" path keeps working.
 */

import { emitKeypressEvents } from 'readline'
import { normalizeSlashCommandInput } from '../commands/index.js'

export interface SlashSuggesterSource {
  /** Returns the list of registered command names + their descriptions */
  getCommands(): Array<{ name: string; description: string }>
  /** Returns the list of skill names + their descriptions */
  getSkills(): Array<{ name: string; description: string }>
  /** Whether live suggestions should be enabled at all */
  isTTY: boolean
}

/** Trim an entry to fit a single display column. */
function shorten(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + '…'
}

export function filterMatches(
  partial: string,
  source: SlashSuggesterSource,
): Array<{ name: string; description: string; kind: 'cmd' | 'skill' }> {
  if (!partial) {
    const cmds = source.getCommands()
    const out: Array<{ name: string; description: string; kind: 'cmd' | 'skill' }> = []
    for (const c of cmds) out.push({ ...c, kind: 'cmd' })
    return out
  }
  const lower = partial.toLowerCase()
  const out: Array<{ name: string; description: string; kind: 'cmd' | 'skill' }> = []
  for (const c of source.getCommands()) {
    if (c.name.toLowerCase().startsWith(lower)) out.push({ ...c, kind: 'cmd' })
  }
  for (const s of source.getSkills()) {
    if (s.name.toLowerCase().startsWith(lower)) out.push({ ...s, kind: 'skill' })
  }
  return out
}

/**
 * ANSI overlay renderer. Holds a single readline interface (or any object with
 * `.write()` + `.cursor`) and re-draws its suggestion block as the line changes.
 *
 * Lifecycle:
 *   - `attach()` installs a keypress listener that recomputes the overlay on
 *     each character (cheap for ~30 entries).
 *   - `detach()` clears the overlay and removes the listener. Idempotent.
 */
export class SlashSuggester {
  private enabled: boolean
  private source: SlashSuggesterSource
  // We write to whatever stream the readline writes to. For our REPL that's
  // `process.stdout`. Readline exposes the stream via `rl.output` if we had
  // a handle; instead we accept it directly so the class stays readline-free
  // and easy to test (the test passes a fake stream).
  private stream: NodeJS.WritableStream
  private getLine: () => string
  private lastHeight = 0
  private attached = false
  private keypressListener: ((s: unknown, k: { name?: string; sequence?: string }) => void) | null = null

  constructor(opts: {
    source: SlashSuggesterSource
    stream: NodeJS.WritableStream
    getLine: () => string
    enabled?: boolean
  }) {
    this.source = opts.source
    this.stream = opts.stream
    this.getLine = opts.getLine
    this.enabled = opts.enabled ?? opts.source.isTTY
  }

  /** Replace the getLine supplier (e.g. once a readline becomes available). */
  setLineSupplier(getLine: () => string): void {
    this.getLine = getLine
  }

  /**
   * Pure completer for `readline.createInterface({ completer })`. Only fires
   * when the user hits Tab. Returns matches with their full names — readline
   * does prefix substitution on the *first word* of the line. We confine to
   * lines that start with `/` and have no space (incomplete command form).
   */
  complete = (line: string): [string[], string] => {
    if (!this.enabled) return [[], line]
    const normalized = normalizeSlashCommandInput(line)
    if (!normalized.startsWith('/')) return [[], line]
    if (normalized.includes(' ')) return [[], line]
    const partial = normalized.slice(1)
    const matches = filterMatches(partial, this.source)
    const names = matches.map((m) => '/' + m.name)
    if (names.length === 0) {
      this.clear()
      return [[], line]
    }
    // Redraw the live overlay on tab so the user sees what they picked.
    this.refresh()
    return [names, line]
  }

  attach(): void {
    if (!this.enabled || this.attached) return
    this.attached = true
    if (!process.stdin.listenerCount('keypress')) {
      emitKeypressEvents(process.stdin)
    }
    this.keypressListener = (_str, key: { name?: string; sequence?: string; ctrl?: boolean; meta?: boolean }) => {
      // Re-render on printable characters + most non-tab keys. Skip modifiers
      // that don't change the text (arrows move within the same buffer but
      // shift the cursor — still re-render to update matches when line shifts).
      if (!key || key.ctrl || key.meta) {
        // Ctrl+C, etc — clear suggestions so they don't linger.
        this.clear()
        return
      }
      // Schedule on next tick so the readline buffer has been updated.
      setImmediate(() => this.refresh())
    }
    process.stdin.on('keypress', this.keypressListener)
  }

  detach(): void {
    if (!this.attached) return
    this.attached = false
    this.clear()
    if (this.keypressListener) {
      process.stdin.removeListener('keypress', this.keypressListener)
      this.keypressListener = null
    }
  }

  /**
   * Recompute matches from the current line and redraw the overlay.
   * Public so callers (e.g. a `line` listener if readline setup changes) can
   * trigger a refresh; the keypress listener handles the normal flow.
   */
  refresh(): void {
    if (!this.enabled) return
    const line = normalizeSlashCommandInput(this.getLine())
    if (!line.startsWith('/') || line.includes(' ')) {
      this.clear()
      return
    }
    const matches = filterMatches(line.slice(1), this.source)
    if (matches.length === 0) {
      this.clear()
      return
    }
    this.render(matches)
  }

  private clear(): void {
    if (this.lastHeight === 0) return
    this.write('\x1b[' + this.lastHeight + 'A\r')
    this.write('\x1b[J')
    this.lastHeight = 0
  }

  private render(matches: Array<{ name: string; description: string; kind: 'cmd' | 'skill' }>): void {
    this.clear()
    const D = '\x1b[2m'
    const R = '\x1b[0m'
    const cyan = '\x1b[36m'
    const visible = matches.slice(0, 7)
    const lines: string[] = []
    const maxName = Math.max(...visible.map((m) => m.name.length), 4)
    for (const m of visible) {
      const tag = m.kind === 'skill' ? ' (skill)' : ''
      const name = '/' + shorten(m.name, maxName).padEnd(maxName)
      const desc = shorten(m.description, 60)
      lines.push(`  ${cyan}${name}${R}${D}  ${desc}${tag}${R}`)
    }
    if (matches.length > visible.length) {
      lines.push(`  ${D}↑↓ navigate · ${visible.length}/${matches.length} shown · /? shows all${R}`)
    }
    this.write('\n')
    for (const l of lines) this.write(l + '\n')
    // Move cursor back up to where the prompt is
    this.write('\x1b[' + lines.length + 'A')
    this.write('\r')
    this.lastHeight = lines.length
  }

  private write(s: string): void {
    this.stream.write(s)
  }
}
