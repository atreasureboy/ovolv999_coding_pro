/**
 * Cost Tracker — accumulate API token usage and compute USD cost
 *
 * Inspired by Claude Code's cost-tracker.ts + services/tokenEstimation.ts.
 *
 * What this adds over the legacy estimateTokens() in compact.ts:
 *   1. Captures REAL usage (prompt_tokens / completion_tokens) from the
 *      OpenAI streaming API's final chunk — no more char-based guessing
 *      for billing.
 *   2. Computes USD cost per model using the registry in providers.ts.
 *   3. Tracks per-model usage breakdown (input/output/cost/apiCalls).
 *   4. Formats a human-readable cost summary for end-of-turn display.
 *   5. File-type-aware token estimation (JSON is denser — 2 bytes/token
 *      vs the default 4).
 */

// ── Model pricing (USD per 1M tokens) ───────────────────────────────────────
// Single source of truth: the model registry in providers.ts (MODELS[]).
// This file used to carry its own duplicated pricing table — prices drifted
// and models had to be maintained in two places. Unknown models resolve to
// null; the unknown-model signal is tracked PER CostTracker instance (see
// `CostTracker.hasUnknownModel()`) so the summary can flag under-reported
// costs instead of silently booking $0.

import { getModelInfo, MODELS } from './providers.js'

export interface ModelPricing {
  inputPer1M: number
  outputPer1M: number
  /** Cache-read rate (USD/1M). Absent → provider-aware default below. */
  cacheReadPer1M?: number
  /** Cache-write rate (USD/1M). Absent → provider-aware default below. */
  cacheWritePer1M?: number
}

/**
 * Round 31 (P2): default cache-rate multipliers when a registry model
 * doesn't carry explicit cache pricing — per PROVIDER, because the old
 * flat "read 10% / write 125%" fallback silently applied Anthropic's
 * economics to every provider (OpenAI auto-caching bills cached reads at
 * 50% with no write premium, Google at 25%+storage, …).
 *
 * Unknown providers default to 1.0/1.0 — no invented discount, i.e. the
 * pre-cache behavior — so /cost can never UNDER-report.
 */
const PROVIDER_CACHE_RATES: Record<string, { read: number; write: number }> = {
  anthropic: { read: 0.1, write: 1.25 },   // official: 10% read / 25% write premium
  openai: { read: 0.5, write: 1.0 },       // cached input 50%, no write premium
  'openai-compatible': { read: 0.5, write: 1.0 },
  minimax: { read: 0.5, write: 1.0 },
  google: { read: 0.25, write: 1.0 },      // explicit context caching
  xai: { read: 0.5, write: 1.0 },
  openrouter: { read: 0.5, write: 1.0 },
  together: { read: 0.5, write: 1.0 },
  groq: { read: 0.5, write: 1.0 },
}

function cacheRates(model: string, pricing: ModelPricing): { readPer1M: number; writePer1M: number } {
  // Round 31 audit F3: getModelInfo is EXACT-match — dated aliases
  // ("gpt-4o-2024-08-06") resolved pricing via longest-prefix but got
  // provider '' here → cached reads billed at 100% (80% over-report for
  // OpenAI aliases). Mirror getModelPricing's prefix strategy.
  let provider = getModelInfo(model)?.provider
  if (!provider) {
    let bestLen = 0
    for (const m of MODELS) {
      if (model.startsWith(m.id) && m.id.length > bestLen) {
        provider = m.provider
        bestLen = m.id.length
      }
    }
  }
  const fallback = (typeof provider === 'string' ? PROVIDER_CACHE_RATES[provider] : undefined) ?? { read: 1, write: 1 }
  return {
    readPer1M: pricing.cacheReadPer1M ?? pricing.inputPer1M * fallback.read,
    writePer1M: pricing.cacheWritePer1M ?? pricing.inputPer1M * fallback.write,
  }
}

/**
 * Look up pricing for a model. Exact registry match first (including
 * provider-prefixed ids, handled by getModelInfo), then longest-prefix
 * match against registry ids so dated aliases keep working
 * ("gpt-4o-2024-08-06" → "gpt-4o", "claude-sonnet-4-6-20250514" →
 * "claude-sonnet-4-6"). Models absent from the registry (legacy/EOL
 * names) return null → CostTracker flags the session's costs as
 * potentially inaccurate rather than pretending they were free.
 *
 * NOTE: providers.ts exports a different getModelPricing that falls back
 * to zero pricing (for context/budget math). This one returns null on
 * purpose — the null IS the unknown-model signal.
 */
export function getModelPricing(model: string): ModelPricing | null {
  const info = getModelInfo(model)
  if (info) return info.pricing

  let best: ModelPricing | null = null
  let bestLen = 0
  for (const m of MODELS) {
    if (model.startsWith(m.id) && m.id.length > bestLen) {
      best = m.pricing
      bestLen = m.id.length
    }
  }
  return best
}

// ── Usage & cost types ──────────────────────────────────────────────────────

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  /** Total input INCLUDES these (see StreamResult). */
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface ModelUsage {
  model: string
  inputTokens: number
  outputTokens: number
  costUSD: number
  apiCalls: number
}

/**
 * Compute USD cost for a single API call.
 * Returns 0 if pricing is unavailable. NOTE: this function is intentionally
 * side-effect-free — the unknown-model signal is tracked per CostTracker
 * instance via `CostTracker.addUsage()` + `hasUnknownModel()`, so concurrent
 * sessions cannot pollute one another's cost summary.
 */
export function calculateUSDCost(model: string, usage: TokenUsage): number {
  const pricing = getModelPricing(model)
  if (!pricing) return 0
  // inputTokens is the TOTAL (uncached + cache-read + cache-write). Split
  // it so each bucket bills exactly once: cached reads at the cache-read
  // rate, cache writes at the creation rate, the remainder at full.
  const rates = cacheRates(model, pricing)
  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  const uncached = Math.max(0, usage.inputTokens - cacheRead - cacheWrite)
  return (
    (uncached / 1_000_000) * pricing.inputPer1M +
    (cacheRead / 1_000_000) * rates.readPer1M +
    (cacheWrite / 1_000_000) * rates.writePer1M +
    (usage.outputTokens / 1_000_000) * pricing.outputPer1M
  )
}

/** What this call WOULD have cost without prompt caching (full input rate
 *  on every token) — the delta vs calculateUSDCost is the cache savings. */
export function calculateUncachedUSDCost(model: string, usage: TokenUsage): number {
  const pricing = getModelPricing(model)
  if (!pricing) return 0
  return (
    (usage.inputTokens / 1_000_000) * pricing.inputPer1M +
    (usage.outputTokens / 1_000_000) * pricing.outputPer1M
  )
}

// ── Formatting helpers (ported from Claude Code) ────────────────────────────

/**
 * Format USD cost with smart decimal places.
 * Large costs → 2 decimals; small costs → 4 decimals (micro-billing accuracy).
 */
export function formatCost(cost: number, maxDecimalPlaces = 4): string {
  return `$${cost > 0.5 ? round(cost, 100).toFixed(2) : cost.toFixed(maxDecimalPlaces)}`
}

/** Format an integer with thousands separators. */
export function formatNumber(n: number): string {
  return n.toLocaleString('en-US')
}

/** Format milliseconds as a human-readable duration (e.g. "1.2s", "2m 13s"). */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rs = Math.round(s % 60)
  return `${m}m ${rs}s`
}

function round(n: number, precision: number): number {
  return Math.round(n * precision) / precision
}

// ── CostTracker ─────────────────────────────────────────────────────────────

/**
 * Accumulates API token usage and cost across a session.
 *
 * Usage:
 *   const tracker = new CostTracker()
 *   tracker.addUsage('gpt-4o', { inputTokens: 1200, outputTokens: 800 })
 *   console.log(tracker.formatSummary())
 */
export class CostTracker {
  private totalCostUSD = 0
  private totalInputTokens = 0
  private totalOutputTokens = 0
  private totalCacheReadTokens = 0
  private totalCacheWriteTokens = 0
  private totalCacheSavedUSD = 0
  private totalAPICalls = 0
  private totalAPIDurationMs = 0
  private modelUsage = new Map<string, ModelUsage>()
  /** Per-instance unknown-model flag (not global) */
  private _hasUnknownModel = false

  /** Record usage from a single API call. */
  addUsage(model: string, usage: TokenUsage, durationMs?: number): void {
    const pricing = getModelPricing(model)
    let cost = 0
    if (pricing) {
      cost = calculateUSDCost(model, usage)
      this.totalCacheSavedUSD += Math.max(0, calculateUncachedUSDCost(model, usage) - cost)
    } else {
      this._hasUnknownModel = true
    }
    this.totalCostUSD += cost
    this.totalInputTokens += usage.inputTokens
    this.totalOutputTokens += usage.outputTokens
    this.totalCacheReadTokens += usage.cacheReadTokens ?? 0
    this.totalCacheWriteTokens += usage.cacheWriteTokens ?? 0
    this.totalAPICalls++
    if (durationMs !== undefined) this.totalAPIDurationMs += durationMs

    const existing = this.modelUsage.get(model)
    if (existing) {
      existing.inputTokens += usage.inputTokens
      existing.outputTokens += usage.outputTokens
      existing.costUSD += cost
      existing.apiCalls++
    } else {
      this.modelUsage.set(model, {
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUSD: cost,
        apiCalls: 1,
      })
    }
  }

  getTotalCost(): number {
    return this.totalCostUSD
  }
  getTotalInputTokens(): number {
    return this.totalInputTokens
  }
  getTotalOutputTokens(): number {
    return this.totalOutputTokens
  }
  getTotalAPICalls(): number {
    return this.totalAPICalls
  }
  getTotalAPIDurationMs(): number {
    return this.totalAPIDurationMs
  }
  /** Whether any unknown model was encountered (costs may be inaccurate) */
  hasUnknownModel(): boolean {
    return this._hasUnknownModel
  }
  getModelUsage(): ModelUsage[] {
    return [...this.modelUsage.values()]
  }

  /** Reset all accumulated state (for tests / new sessions). */
  reset(): void {
    this.totalCostUSD = 0
    this.totalInputTokens = 0
    this.totalOutputTokens = 0
    this.totalCacheReadTokens = 0
    this.totalCacheWriteTokens = 0
    this.totalCacheSavedUSD = 0
    this.totalAPICalls = 0
    this.totalAPIDurationMs = 0
    this.modelUsage.clear()
    this._hasUnknownModel = false
  }

  /** Tokens served from the provider prompt cache this session. */
  getTotalCacheReadTokens(): number {
    return this.totalCacheReadTokens
  }

  /** Estimated USD saved by prompt caching this session. */
  getCacheSavedUSD(): number {
    return this.totalCacheSavedUSD
  }

  /**
   * Format a multi-line cost summary for end-of-turn / end-of-session display.
   * Modeled on Claude Code's formatTotalCost().
   */
  formatSummary(): string {
    const costDisplay =
      formatCost(this.totalCostUSD) +
      (this._hasUnknownModel
        ? ' (costs may be inaccurate — unknown model pricing)'
        : '')

    const lines: string[] = [
      `Total cost:           ${costDisplay}`,
      `Total tokens:         ${formatNumber(this.totalInputTokens)} input, ${formatNumber(this.totalOutputTokens)} output`,
    ]
    if (this.totalCacheReadTokens > 0 || this.totalCacheWriteTokens > 0) {
      lines.push(
        `Prompt cache:         ${formatNumber(this.totalCacheReadTokens)} read, ${formatNumber(this.totalCacheWriteTokens)} written (saved ~${formatCost(this.totalCacheSavedUSD)})`,
      )
    }
    lines.push(`Total API calls:      ${this.totalAPICalls}`)

    if (this.totalAPIDurationMs > 0) {
      lines.push(`Total API duration:   ${formatDuration(this.totalAPIDurationMs)}`)
    }

    const usage = this.getModelUsage()
    if (usage.length > 0) {
      lines.push('Usage by model:')
      for (const u of usage) {
        lines.push(
          `  ${u.model}: ${formatNumber(u.inputTokens)} in, ${formatNumber(u.outputTokens)} out, ${u.apiCalls} call${u.apiCalls === 1 ? '' : 's'} (${formatCost(u.costUSD)})`,
        )
      }
    }

    return lines.join('\n')
  }
}

// ── File-type-aware token estimation (ported from Claude Code) ──────────────

/**
 * Estimate token count from raw text.
 * Default ratio: 4 bytes/token (matching OpenAI's rough guidance).
 */
export function roughTokenCountEstimation(
  content: string,
  bytesPerToken = 4,
): number {
  return Math.round(content.length / bytesPerToken)
}

/**
 * Returns estimated bytes-per-token ratio for a file extension.
 * Dense JSON has many single-character tokens ({, }, :, ,, ") making the
 * real ratio closer to 2 rather than 4.
 *
 * Ported from Claude Code's bytesPerTokenForFileType().
 */
export function bytesPerTokenForFileType(fileExtension: string): number {
  switch (fileExtension.toLowerCase()) {
    case 'json':
    case 'jsonl':
    case 'jsonc':
      return 2
    default:
      return 4
  }
}

/**
 * Like roughTokenCountEstimation but uses a more accurate bytes-per-token
 * ratio when the file type is known. Matters when falling back to estimates
 * for large tool results — an underestimate can let oversized content slip in.
 */
export function roughTokenCountEstimationForFileType(
  content: string,
  fileExtension: string,
): number {
  return roughTokenCountEstimation(content, bytesPerTokenForFileType(fileExtension))
}
