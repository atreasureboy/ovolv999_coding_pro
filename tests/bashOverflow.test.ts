import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BashTool } from '../src/tools/bash.js'
import type { ToolContext } from '../src/core/types.js'

/**
 * Round 36 (opencode overflow-file pattern): when bash output exceeds the
 * head+tail live buffer, the dropped portion is NOT lost — the stream is
 * recorded to <sessionDir>/bash-output/ and the truncation marker points
 * the model at the file.
 */

const tool = new BashTool()
let sessionDir = ''

function ctx(): ToolContext {
  return { cwd: process.cwd(), permissionMode: 'auto', sessionDir }
}

beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), 'ovogo-bash-overflow-'))
})

afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true })
})

describe('BashTool overflow file', () => {
  it('records overflowing output and points the model at the file', async () => {
    // ~600KB — far past the 2x14KB live buffer.
    const result = await tool.execute({ command: 'seq 1 30000' }, ctx())
    expect(result.isError).toBe(false)
    expect(result.content).toContain('bytes of live output dropped')
    expect(result.content).toContain('Full output recorded in:')

    const dir = join(sessionDir, 'bash-output')
    expect(existsSync(dir)).toBe(true)
    const logs = readdirSync(dir).filter((f) => f.endsWith('.log'))
    expect(logs.length).toBeGreaterThan(0)
    const size = statSync(join(dir, logs[0])).size
    // The file captures the post-overflow tail of the stream — it must be
    // substantial, proving chunks were actually appended.
    expect(size).toBeGreaterThan(50_000)
  })

  it('does not create a log file for small output', async () => {
    const result = await tool.execute({ command: 'echo hello' }, ctx())
    expect(result.isError).toBe(false)
    expect(result.content).toContain('hello')
    expect(result.content).not.toContain('Full output recorded in:')
    const dir = join(sessionDir, 'bash-output')
    if (existsSync(dir)) {
      expect(readdirSync(dir).filter((f) => f.endsWith('.log'))).toHaveLength(0)
    }
  })

  it('keeps head AND tail visible around the marker', async () => {
    const result = await tool.execute({ command: 'seq 1 30000' }, ctx())
    // Head: the first numbers. Tail: the last number.
    expect(result.content).toMatch(/^1\n2\n/m)
    expect(result.content).toContain('30000')
  })
})
