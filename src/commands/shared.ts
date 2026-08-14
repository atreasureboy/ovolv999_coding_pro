/**
 * Shared helpers for the builtin slash-command groups.
 *
 * Round 29 (builtin.ts split): the 3,800-line god module was cut into
 * thematic group files under ./cmd/ — this module carries the pieces
 * every group uses (result constructors, hidden-input reader, the
 * /workers manager singleton, permission persistence).
 */

import type { SlashCommandContext, SlashCommandResult } from './index.js'
import { readSync } from 'fs'
import { ClaudeCodeWorkerManager } from '../core/claudeCodeWorkerManager.js'

export const text = (value: string): SlashCommandResult => ({ type: 'text', value })
export const exit = (): SlashCommandResult => ({ type: 'exit' })

/** Synchronously read one line from stdin without echoing (TTY raw mode). */
export function readHiddenLine(): string {
  const stdin = process.stdin
  const wasRaw = typeof stdin.setRawMode === 'function' ? (stdin.isRaw ?? false) : false
  if (typeof stdin.setRawMode === 'function') {
    stdin.setRawMode(true)
    stdin.resume()
  }
  let value = ''
  const buf = Buffer.alloc(1)
  while (true) {
    let bytesRead: number
    try {
      bytesRead = readSync(stdin.fd, buf, 0, 1, null)
    } catch {
      break
    }
    if (bytesRead === 0) break
    const ch = buf[0]
    if (ch === 0x0d || ch === 0x0a) break
    if (ch === 0x03) {
      if (typeof stdin.setRawMode === 'function') stdin.setRawMode(wasRaw)
      process.stdout.write('\n')
      throw new Error('interrupted')
    }
    if (ch === 0x08 || ch === 0x7f) {
      if (value.length > 0) {
        value = value.slice(0, -1)
        process.stdout.write('\b \b')
      }
      continue
    }
    if (ch < 0x20) continue
    value += buf.toString('utf8')
    if (typeof stdin.setRawMode === 'function') process.stdout.write('*')
  }
  if (typeof stdin.setRawMode === 'function') stdin.setRawMode(wasRaw)
  process.stdout.write('\n')
  return value
}

/** Module-level singleton — overridable via {@link setWorkerManager} for tests. */
let workerManager: ClaudeCodeWorkerManager = new ClaudeCodeWorkerManager()

/** Replace the /workers manager. Used by tests; safe to call once at startup. */
export function setWorkerManager(manager: ClaudeCodeWorkerManager): void {
  workerManager = manager
}

/** Reset to a fresh default manager — restores production behavior in tests. */
export function resetWorkerManager(): void {
  workerManager = new ClaudeCodeWorkerManager()
}

export function getWorkerManager(): ClaudeCodeWorkerManager {
  return workerManager
}

export function persistPermissionState(ctx: SlashCommandContext): string {
  const path = ctx.persistPermissions?.(
    ctx.engine.getPermissionManager().getMode(),
    ctx.engine.getPermissionManager().getRules(),
  )
  return path ? '\nSaved to: ' + path : ''
}
