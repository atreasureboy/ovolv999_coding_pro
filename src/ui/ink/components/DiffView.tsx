/**
 * DiffView — inline diff display for file edits.
 *
 * Shows old → new changes with red/green coloring.
 * Used by ToolCallView when a Write/Edit tool produces a diff.
 *
 * This is a presentational component — the diff computation happens
 * in the caller (or could be extracted to a utility).
 */

import { Text, Box } from 'ink'
import { t } from '../../theme.js'

export interface DiffLine {
  type: 'add' | 'remove' | 'context'
  text: string
  oldLineNum?: number
  newLineNum?: number
}

export function DiffView({
  lines,
  maxLines = 30,
}: {
  lines: DiffLine[]
  maxLines?: number
}): React.ReactElement {
  const shown = lines.slice(0, maxLines)
  const hidden = lines.length - shown.length

  return (
    <Box flexDirection="column" marginLeft={1}>
      {shown.map((line, i) => {
        const prefix =
          line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '
        const color =
          line.type === 'add'
            ? t.diffAdded
            : line.type === 'remove'
              ? t.diffRemoved
              : t.muted
        // Round 44: soft row background + gutter numbers — diff rows read
        // as bands instead of a wall of bright glyphs.
        const bg = line.type === 'add' ? t.diffAddedBg : line.type === 'remove' ? t.diffRemovedBg : undefined
        const lineNum = line.type === 'remove'
          ? (line.oldLineNum ?? '')
          : (line.newLineNum ?? '')

        return (
          <Text key={i} backgroundColor={bg}>
            <Text color={t.diffLineNumber}>{String(lineNum).padStart(4, ' ')} </Text>
            <Text color={color} dimColor={line.type === 'context'}>
              {prefix} {line.text.length > 100 ? line.text.slice(0, 97) + '…' : line.text + '\n'}
            </Text>
          </Text>
        )
      })}
      {hidden > 0 ? (
        <Text color={t.faint}>     … {hidden} more lines</Text>
      ) : null}
    </Box>
  )
}

/**
 * Compute a line-level diff between old and new text using LCS.
 *
 * Uses the standard dynamic-programming Longest Common Subsequence
 * algorithm to find the optimal alignment, then backtracks to
 * produce interleaved add/remove/context lines.
 *
 * This is O(n*m) in time and space — fine for typical file edits
 * (hundreds of lines). For very large diffs, the maxLines cap in
 * DiffView limits the rendered output.
 */
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')

  // ── LCS dynamic programming table ──────────────────────────────────────
  // dp[i][j] = length of LCS of oldLines[0..i) and newLines[0..j)
  const n = oldLines.length
  const m = newLines.length

  // Optimize: for very large inputs, fall back to prefix/suffix diff
  if (n * m > 500_000) {
    return computeSimpleDiff(oldLines, newLines)
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0))
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  // ── Backtrack to produce diff lines ────────────────────────────────────
  const rawDiff: DiffLine[] = []
  let i = n, j = m
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      rawDiff.push({ type: 'context', text: oldLines[i - 1], oldLineNum: i, newLineNum: j })
      i--; j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      rawDiff.push({ type: 'add', text: newLines[j - 1], newLineNum: j })
      j--
    } else {
      rawDiff.push({ type: 'remove', text: oldLines[i - 1], oldLineNum: i })
      i--
    }
  }
  rawDiff.reverse()

  // ── Trim long runs of context (keep 3 lines around changes) ───────────
  return trimContext(rawDiff, 3)
}

/**
 * Trim long runs of context lines, keeping only `keep` lines around
 * each change. This makes large diffs readable.
 */
function trimContext(lines: DiffLine[], keep: number): DiffLine[] {
  const result: DiffLine[] = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].type !== 'context') {
      result.push(lines[i])
      continue
    }
    // Check if this context line is near a change
    const before = lines.slice(Math.max(0, i - keep), i)
    const after = lines.slice(i + 1, Math.min(lines.length, i + 1 + keep))
    const nearChange =
      before.some((l) => l.type !== 'context') ||
      after.some((l) => l.type !== 'context')
    if (nearChange) {
      result.push(lines[i])
    } else if (result.length > 0 && result[result.length - 1].text !== '...') {
      result.push({ type: 'context', text: '...' })
    }
  }
  return result
}

/**
 * Simple prefix/suffix diff — fallback for very large inputs.
 */
function computeSimpleDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const result: DiffLine[] = []

  let prefixLen = 0
  while (prefixLen < oldLines.length && prefixLen < newLines.length && oldLines[prefixLen] === newLines[prefixLen]) {
    prefixLen++
  }

  let suffixLen = 0
  while (
    suffixLen < oldLines.length - prefixLen &&
    suffixLen < newLines.length - prefixLen &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++
  }

  for (let i = Math.max(0, prefixLen - 2); i < prefixLen; i++) {
    result.push({ type: 'context', text: oldLines[i], oldLineNum: i + 1, newLineNum: i + 1 })
  }
  for (let i = prefixLen; i < oldLines.length - suffixLen; i++) {
    result.push({ type: 'remove', text: oldLines[i], oldLineNum: i + 1 })
  }
  for (let i = prefixLen; i < newLines.length - suffixLen; i++) {
    result.push({ type: 'add', text: newLines[i], newLineNum: i + 1 })
  }
  for (let i = 0; i < Math.min(suffixLen, 2); i++) {
    const idx = newLines.length - suffixLen + i
    result.push({ type: 'context', text: newLines[idx], newLineNum: idx + 1 })
  }

  return result
}
