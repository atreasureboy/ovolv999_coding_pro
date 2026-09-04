/**
 * common.ts — top-level helpers hoisted out of the old builtin.ts
 * (Round 29 split). Every command group under ./cmd/ imports from here.
 */

/*
 * Lazy-require pattern (inherited from builtin.ts): command handlers
 * require rarely-used modules at dispatch time to keep CLI startup lean.
 * The pattern is intentional; these rules would fire on every require.
 */
 


import type { OpenAIMessage } from '../../core/types.js'
import { loadProfiles } from '../../core/profiles.js'

export function previewMessage(msg: OpenAIMessage, max: number): string {
  const raw = typeof msg.content === 'string'
    ? msg.content
    : JSON.stringify(msg.content ?? msg.tool_calls ?? '')
  const oneLine = raw.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : oneLine.slice(0, Math.max(0, max - 1)) + '…'
}

export function roleLabel(role: string): string {
  if (role === 'user') return 'You'
  if (role === 'assistant') return 'AI'
  if (role === 'tool') return 'Tool'
  if (role === 'system') return 'Sys'
  return role
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `... (${s.length - max} more chars)`
}

export function loadProfilesRaw(cwd: string) {
  return loadProfiles(cwd)
}
