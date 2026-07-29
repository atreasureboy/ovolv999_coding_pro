/**
 * Terminal title — set the terminal window/tab title via OSC escape sequence.
 *
 * Works in most modern terminals: xterm, iTerm2, gnome-terminal, kitty,
 * Alacritty, Windows Terminal, tmux (passthrough).
 *
 * Format: ESC ] 0 ; <title> BEL
 */

let originalTitle: string | null = null

/**
 * Set the terminal title.
 */
export function setTerminalTitle(title: string): void {
  if (!process.stdout.isTTY) return
  try {
    process.stdout.write(`\x1b]0;${title}\x07`)
  } catch {
    // Best-effort — some environments (pipes, logs) don't support this
  }
}

/**
 * Save the current title (for later restoration) and set a new one.
 */
export function initTerminalTitle(title: string): void {
  // We can't read the current title programmatically, so we just set it.
  // On restore, we set a generic title.
  originalTitle = title
  setTerminalTitle(title)
}

/**
 * Restore a reasonable terminal title (call on exit).
 */
export function restoreTerminalTitle(): void {
  setTerminalTitle(originalTitle ?? 'terminal')
}

/**
 * Update the title to reflect current state.
 * Example: 'ovolv999 · gpt-4o · thinking...'
 */
export function updateTerminalTitle(model: string, running: boolean): void {
  const status = running ? '⟳ working' : 'ovolv999'
  setTerminalTitle(`${status} · ${model}`)
}
