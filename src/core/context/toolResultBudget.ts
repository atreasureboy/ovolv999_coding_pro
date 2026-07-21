/**
 * Tool Result Budget — truncation and aggregate budget enforcement
 * for tool results. Extracted from engine.ts module-level functions.
 *
 * Two levels:
 * 1. Per-result: truncateToolResult — single result > 20K chars
 *    gets persisted to disk with a preview + path.
 * 2. Aggregate: enforceAggregateBudget — when the total of all parallel
 *    results exceeds 60K, largest items are persisted/truncated until
 *    the aggregate fits.
 */

import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

const MAX_TOOL_RESULT_LENGTH = 20_000
const MAX_AGGREGATE_TOOL_RESULTS = 60_000

export function truncateToolResult(result: string, sessionDir?: string): string {
  if (result.length <= MAX_TOOL_RESULT_LENGTH) return result

  if (sessionDir) {
    try {
      const dir = join(sessionDir, 'tool-results')
      mkdirSync(dir, { recursive: true })
      const fileName = `result_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`
      const filePath = join(dir, fileName)
      writeFileSync(filePath, result, 'utf8')
      const preview = result.slice(0, 2000)
      return `${preview}\n\n[... Full output (${result.length} chars) saved to: ${filePath} ...]`
    } catch {
      // Fall through to truncation
    }
  }

  const half = MAX_TOOL_RESULT_LENGTH / 2
  return (
    result.slice(0, half) +
    `\n\n[... ${result.length - MAX_TOOL_RESULT_LENGTH} chars truncated ...]\n\n` +
    result.slice(result.length - half)
  )
}

export function enforceAggregateToolResultBudget(
  results: { content: string; tc: { id: string; name: string } }[],
  sessionDir?: string,
): void {
  const totalChars = results.reduce((sum, r) => sum + r.content.length, 0)
  if (totalChars <= MAX_AGGREGATE_TOOL_RESULTS) return
  if (results.length === 0) return

  const itemTarget = Math.max(1, Math.floor(MAX_AGGREGATE_TOOL_RESULTS / results.length))

  const indexed = results.map((r, i) => ({ r, i, size: r.content.length }))
  indexed.sort((a, b) => b.size - a.size)

  let currentTotal = totalChars
  for (const item of indexed) {
    if (currentTotal <= MAX_AGGREGATE_TOOL_RESULTS) break

    if (item.size <= itemTarget) continue

    if (item.size > MAX_TOOL_RESULT_LENGTH && sessionDir) {
      const original = item.r.content
      try {
        const dir = join(sessionDir, 'tool-results')
        mkdirSync(dir, { recursive: true })
        const fileName = `result_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`
        const filePath = join(dir, fileName)
        writeFileSync(filePath, original, 'utf8')
        const preview = original.slice(0, 2000)
        const replacement =
          `${preview}\n\n[... Full output (${original.length} chars) saved to: ${filePath} ...]`
        results[item.i].content = replacement
        currentTotal += replacement.length - original.length
        continue
      } catch {
        // Disk write failed — fall through to in-memory truncation.
      }
    }

    const original = item.r.content
    if (original.length === 0) continue
    const headLen = Math.max(1, Math.floor(itemTarget / 2))
    const tailLen = Math.max(1, itemTarget - headLen)
    const truncated =
      original.slice(0, headLen) +
      `\n\n[... ${original.length - (headLen + tailLen)} chars truncated to fit aggregate budget ...]\n\n` +
      original.slice(original.length - tailLen)
    results[item.i].content = truncated
    currentTotal += truncated.length - original.length
  }
}
