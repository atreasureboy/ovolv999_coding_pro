/**
 * TTY detection — single source of truth for "is this an interactive
 * terminal session?".
 *
 * The golden path branches on this (v0.4.1 WS2): interactive terminals get
 * the first-run wizard; non-TTY callers (CI, pipes, cron) would hang a
 * readline forever on their closed stdin, so they get an actionable stderr
 * block + exit code instead.
 *
 * Injectable for tests; defaults to the real process streams.
 */

export interface TtyLike {
  isTTY?: boolean
}

export function isInteractiveTerminal(
  stdin: TtyLike = process.stdin,
  stdout: TtyLike = process.stdout,
): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY)
}
