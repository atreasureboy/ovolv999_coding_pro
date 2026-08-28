/**
 * Structured TurnOutcome Card formatting (v0.4 Daily Driver UX Convergence).
 *
 * Formats canonical TurnOutcome details into a clear, readable result card
 * for CLI & Ink interfaces.
 */

import type { ModelCallAttempt, TurnOutcome } from '../core/runtime/turnOutcome.js'
import type { RendererInterface } from './renderer.js'

export interface OutcomeCardOptions {
  outcome: TurnOutcome
  elapsedSec: string
  /** Startup/preferred model — used only when no attempt data exists. */
  model: string
  costStr?: string
}

/**
 * v0.4.1 WS5 (UI model truth): the model the card should display.
 * After a fallback chain A→B the turn was ANSWERED by B, so the card
 * must say B even though opts.model (startup config) says A.
 * Precedence: last SUCCEEDED attempt → last attempt of any kind →
 * the caller's fallback. Never fabricated — if the attempts array is
 * empty, the startup model is the only truth we have.
 */
export function effectiveModelFor(outcome: { modelAttempts?: ModelCallAttempt[] }, fallback: string): string {
  const attempts = outcome.modelAttempts ?? []
  if (attempts.length === 0) return fallback
  for (let i = attempts.length - 1; i >= 0; i--) {
    if (attempts[i].status === 'succeeded') return attempts[i].model
  }
  return attempts[attempts.length - 1].model
}

export function formatOutcomeCardText(opts: OutcomeCardOptions): string {
  const { outcome, elapsedSec, costStr } = opts
  const status = outcome.completion?.status ?? 'completed'

  // Round 46 (codex detail): `─ Worked for 12s ─────` — the turn-end
  // marker is ONE quiet divider line, not a multi-row emoji card. Status
  // and blockers still surface when they matter (non-completed turns);
  // a completed turn just shows duration + cost.
  const lines: string[] = []
  const head = `Worked for ${elapsedSec}s${costStr ? ` · ${costStr}` : ''}`
  const width = Math.max(40, head.length + 4)
  const dashes = Math.max(3, width - head.length - 4)
  lines.push(`─ ${head} ${'─'.repeat(dashes)}`)

  const attention: string[] = []
  if (status !== 'completed' && status !== 'cancelled') {
    attention.push(`status: ${status}`)
  }
  if (outcome.changedFiles && outcome.changedFiles.length > 0) {
    const shown = outcome.changedFiles.slice(0, 5)
    attention.push(`changed ${shown.map((f) => f.split('/').pop()).filter(Boolean).join(', ')}${outcome.changedFiles.length > 5 ? ` +${outcome.changedFiles.length - 5}` : ''}`)
  }
  if (outcome.verification?.executed) {
    attention.push(outcome.verification.passed ? 'verification passed' : 'verification FAILED')
  }
  for (const r of (outcome.completion?.reasons ?? []).slice(0, 3)) {
    attention.push(r)
  }
  for (const a of (outcome.completion?.requiredNextActions ?? []).slice(0, 2)) {
    attention.push(`next: ${a}`)
  }
  for (const a of attention) {
    lines.push(`  · ${a}`)
  }

  return lines.join('\n')
}

export function renderOutcomeCard(renderer: RendererInterface, opts: OutcomeCardOptions): void {
  const cardText = formatOutcomeCardText(opts)
  const status = opts.outcome.completion?.status ?? 'completed'
  if (status === 'completed') {
    renderer.success(cardText)
  } else if (status === 'cancelled') {
    renderer.warn(cardText)
  } else if (status === 'blocked' || status === 'failed') {
    renderer.error(cardText)
  } else {
    renderer.info(cardText)
  }
}
