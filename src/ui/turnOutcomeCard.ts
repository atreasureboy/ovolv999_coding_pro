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
  const { outcome, elapsedSec, model, costStr } = opts
  const effectiveModel = effectiveModelFor(outcome, model)
  const status = outcome.completion?.status ?? 'completed'
  const statusSymbol =
    status === 'completed' ? '✓ COMPLETED' :
    status === 'partial' ? '◐ PARTIAL' :
    status === 'blocked' ? '🛑 BLOCKED' :
    status === 'cancelled' ? '⚡ CANCELLED' :
    status === 'failed' ? '✗ FAILED' : '⚠️ EXHAUSTED'

  const lines: string[] = []
  lines.push(`Turn Outcome: ${statusSymbol}`)
  lines.push(`  ⏱ Duration: ${elapsedSec}s  ·  Model: ${effectiveModel}${costStr ? `  ·  Cost: ${costStr}` : ''}`)

  if (outcome.changedFiles && outcome.changedFiles.length > 0) {
    lines.push(`  📁 Modified files (${outcome.changedFiles.length}):`)
    for (const file of outcome.changedFiles.slice(0, 8)) {
      lines.push(`     - ${file}`)
    }
    if (outcome.changedFiles.length > 8) {
      lines.push(`     - ... and ${outcome.changedFiles.length - 8} more`)
    }
  }

  if (outcome.verification) {
    if (outcome.verification.executed) {
      const vStatus = outcome.verification.passed ? 'PASSED' : 'FAILED'
      lines.push(`  🧪 Verification: Executed (${vStatus})`)
      if (outcome.verification.failed && outcome.verification.failed.length > 0) {
        for (const failItem of outcome.verification.failed.slice(0, 3)) {
          lines.push(`     - ${failItem}`)
        }
      }
    } else {
      lines.push(`  🧪 Verification: Not executed`)
    }
  }

  if (outcome.completion?.reasons && outcome.completion.reasons.length > 0) {
    lines.push(`  🛑 Blockers / Reasons:`)
    for (const r of outcome.completion.reasons) {
      lines.push(`     - ${r}`)
    }
  }

  if (outcome.completion?.requiredNextActions && outcome.completion.requiredNextActions.length > 0) {
    lines.push(`  📋 Required Next Actions:`)
    for (const act of outcome.completion.requiredNextActions) {
      lines.push(`     - ${act}`)
    }
  }

  lines.push(`  💡 Quick Actions: /diff  ·  /undo  ·  /why`)

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
