/**
 * Cost Tracker — accumulate API token usage and compute USD cost
 *
 * Inspired by Claude Code's cost-tracker.ts + services/tokenEstimation.ts.
 *
 * What this adds over the legacy estimateTokens() in compact.ts:
 *   1. Captures REAL usage (prompt_tokens / completion_tokens) from the
 *      OpenAI streaming API's final chunk — no more char-based guessing
 *      for billing.
 *   2. Computes USD cost per model using a pricing table.
 *   3. Tracks per-model usage breakdown (input/output/cost/apiCalls).
 *   4. Formats a human-readable cost summary for end-of-turn display.
 *   5. File-type-aware token estimation (JSON is denser — 2 bytes/token
 *      vs the default 4).
 */

// ── Model pricing (USD per 1M tokens) ───────────────────────────────────────
// Sources: OpenAI / Anthropic / DeepSeek public pricing pages.
// Prices change — treat as approximate. Unknown models → cost 0 + flag.

export interface ModelPricing {
  inputPer1M: number
  outputPer1M: number
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  // OpenAI
  'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10 },
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6 },
  'gpt-4-turbo': { inputPer1M: 10, outputPer1M: 30 },
  'gpt-4': { inputPer1M: 30, outputPer1M: 60 },
  'gpt-3.5-turbo': { inputPer1M: 0.5, outputPer1M: 1.5 },
  'o1': { inputPer1M: 15, outputPer1M: 60 },
  'o1-mini': { inputPer1M: 3, outputPer1M: 12 },
  'o1-pro': { inputPer1M: 150, outputPer1M: 600 },
  'o3': { inputPer1M: 10, outputPer1M: 40 },
  'o3-mini': { inputPer1M: 1.1, outputPer1M: 4.4 },
  'o4-mini': { inputPer1M: 1.1, outputPer1M: 4.4 },
  // Anthropic (Claude)
  'claude-sonnet-4-6': { inputPer1M: 3, outputPer1M: 15 },
  'claude-sonnet-4': { inputPer1M: 3, outputPer1M: 15 },
  'claude-opus-4': { inputPer1M: 15, outputPer1M: 75 },
  'claude-haiku-3-5': { inputPer1M: 0.8, outputPer1M: 4 },
  'claude-3-5-sonnet': { inputPer1M: 3, outputPer1M: 15 },
  'claude-3-5-haiku': { inputPer1M: 0.8, outputPer1M: 4 },
  'claude-3-opus': { inputPer1M: 15, outputPer1M: 75 },
  // DeepSeek
  'deepseek-chat': { inputPer1M: 0.27, outputPer1M: 1.1 },
  'deepseek-reasoner': { inputPer1M: 0.55, outputPer1M: 2.19 },
  'deepseek-coder': { inputPer1M: 0.14, outputPer1M: 0.28 },
}

/** Unknown-model flag — set when a model isn't in the pricing table. */
let _hasUnknownModelCost = false

/**
 * Look up pricing for a model. Tries exact match, then longest-prefix match
 * (so "gpt-4o-2024-08-06" matches "gpt-4o", "claude-sonnet-4-6-20250514"
 * matches "claude-sonnet-4-6").
 */
export function getModelPricing(model: string): ModelPricing | null {
  // Exact match
  if (MODEL_PRICING[model]) return MODEL_PRICING[model]

  // Prefix match — longest prefix wins (most specific)
  let best: ModelPricing | null = null
  let bestLen = 0
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (model.startsWith(key) && key.length > bestLen) {
      best = pricing
      bestLen = key.length
    }
  }
  return best
}

/** Whether any unknown model was encountered (costs may be inaccurate). */
export function hasUnknownModelCost(): boolean {
  return _hasUnknownModelCost
}

/** Reset the unknown-model flag (for tests / new sessions). */
export function resetUnknownModelCost(): void {
  _hasUnknownModelCost = false
}

// ── Usage & cost types ──────────────────────────────────────────────────────

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
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
 * Returns 0 and sets the unknown-model flag if pricing is unavailable.
 */
export function calculateUSDCost(model: string, usage: TokenUsage): number {
  const pricing = getModelPricing(model)
  if (!pricing) {
    _hasUnknownModelCost = true
    return 0
  }
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
      cost =
        (usage.inputTokens / 1_000_000) * pricing.inputPer1M +
        (usage.outputTokens / 1_000_000) * pricing.outputPer1M
    } else {
      this._hasUnknownModel = true
    }
    this.totalCostUSD += cost
    this.totalInputTokens += usage.inputTokens
    this.totalOutputTokens += usage.outputTokens
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
    this.totalAPICalls = 0
    this.totalAPIDurationMs = 0
    this.modelUsage.clear()
    this._hasUnknownModel = false
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
      `Total API calls:      ${this.totalAPICalls}`,
    ]

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
