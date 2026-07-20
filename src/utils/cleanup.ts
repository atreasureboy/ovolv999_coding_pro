/**
 * Cleanup — process-level terminal state restoration.
 *
 * Ensures the terminal is left in a clean state even when the process
 * crashes, receives SIGTERM/SIGHUP, or has an uncaught exception.
 *
 * Registers handlers for:
 * - SIGTERM / SIGHUP (terminal closed, kill signal)
 * - uncaughtException
 * - unhandledRejection
 *
 * Returns a cleanup function for graceful-exit callers to invoke.
 * The cleanup is idempotent — calling it multiple times is safe.
 */

import { restoreTerminalTitle } from './terminalTitle.js'

export interface CleanupOptions {
  /** Called during cleanup (e.g. to unmount Ink instance). */
  onCleanup?: () => void
}

/**
 * Register process-level cleanup handlers.
 * Returns a function that unregisters the handlers and runs cleanup
 * (for use after graceful exit).
 */
export function registerCleanup(opts: CleanupOptions = {}): () => void {
  let cleaned = false

  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    try { restoreTerminalTitle() } catch { /* best-effort */ }
    try {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false)
      }
    } catch { /* best-effort */ }
    try { opts.onCleanup?.() } catch { /* best-effort */ }
  }

  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGHUP']
  const handlers: Record<string, () => void> = {}

  for (const sig of signals) {
    handlers[sig] = (): void => {
      cleanup()
      process.exit(130)
    }
    process.on(sig, handlers[sig])
  }

  const crashHandler = (): void => {
    cleanup()
    process.exit(1)
  }
  process.on('uncaughtException', crashHandler)
  process.on('unhandledRejection', crashHandler)

  return (): void => {
    for (const sig of signals) {
      process.off(sig, handlers[sig])
    }
    process.off('uncaughtException', crashHandler)
    process.off('unhandledRejection', crashHandler)
    cleanup()
  }
}
