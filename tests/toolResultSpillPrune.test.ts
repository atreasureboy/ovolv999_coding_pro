/**
 * Spill-file pruning: truncateToolResult persists oversized tool outputs
 * under <sessionDir>/tool-results/ and references the path in the model
 * message. Nothing ever cleaned that directory, so a long-running session
 * grew it without limit. Pruning must keep the directory bounded (newest
 * files win) without breaking the spill contract.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { truncateToolResult } from '../src/core/context/toolResultBudget.js'

let sessionDir = ''
beforeEach(() => {
  sessionDir = mkdtempSync(`${tmpdir()}/spill-`)
})
afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true })
})

describe('toolResultBudget spill pruning', () => {
  it('keeps the spill directory bounded as spills accumulate', () => {
    const big = 'x'.repeat(25_000)
    for (let i = 0; i < 105; i++) {
      truncateToolResult(big, sessionDir)
    }
    const dir = join(sessionDir, 'tool-results')
    expect(existsSync(dir)).toBe(true)
    expect(readdirSync(dir).length).toBeLessThanOrEqual(100)
  })

  it('the newest spills survive pruning and keep the readable-path contract', () => {
    const big = 'y'.repeat(25_000)
    let lastPath = ''
    for (let i = 0; i < 103; i++) {
      const exposed = truncateToolResult(big, sessionDir)
      const match = exposed.match(/saved to: (.+) \.\.\.\]$/)
      expect(match, 'exposed text must reference the spill file').not.toBeNull()
      lastPath = match![1]
    }
    // The most recent spill — the one the model was just told about —
    // must still exist with the full content.
    expect(existsSync(lastPath)).toBe(true)
    expect(readFileSync(lastPath, 'utf8')).toBe(big)
  })

  it('small results never spill and never create the directory', () => {
    const out = truncateToolResult('small', sessionDir)
    expect(out).toBe('small')
    expect(existsSync(join(sessionDir, 'tool-results'))).toBe(false)
  })
})
