/**
 * Structured ToolResult tests (fi_goal.md §六 Phase 5 / GAP-A).
 */

import { describe, it, expect } from 'vitest'
import {
  isStructuredResult,
  toStructured,
  toLegacy,
  ok,
  failed,
  cancelled,
  timedOut,
  routeLargeOutput,
  DEFAULT_LARGE_OUTPUT_BYTES,
  type StructuredToolResult,
  type AnyToolResult,
  type LegacyToolResult,
} from '../src/core/structuredToolResult.js'
import { BashTool } from '../src/tools/bash.js'
import { spawn } from 'child_process'

function bashCtx(signal?: AbortSignal) {
  return {
    signal,
    cwd: process.cwd(),
    renderer: { toolResult: () => {}, warn: () => {}, info: () => {}, raw: () => {} } as never,
  } as never
}

// ─────────────────────────────────────────────────────────────────────
// isStructuredResult
// ─────────────────────────────────────────────────────────────────────
describe('isStructuredResult', () => {
  it('returns true for a structured result', () => {
    expect(isStructuredResult(ok({ summary: 'x' }))).toBe(true)
  })
  it('returns false for a legacy result', () => {
    expect(isStructuredResult({ content: 'x', isError: false })).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────
// toStructured
// ─────────────────────────────────────────────────────────────────────
describe('toStructured', () => {
  it('passes structured results through unchanged', () => {
    const s = ok({ summary: 'hello' })
    expect(toStructured(s)).toBe(s)
  })

  it('maps legacy success → status=success, summary=content', () => {
    const s = toStructured({ content: 'all good', isError: false })
    expect(s.status).toBe('success')
    expect(s.summary).toBe('all good')
  })

  it('maps legacy error → status=failed, summary=content', () => {
    const s = toStructured({ content: 'kaboom', isError: true })
    expect(s.status).toBe('failed')
    expect(s.summary).toBe('kaboom')
  })
})

// ─────────────────────────────────────────────────────────────────────
// toLegacy (boundary normalizer)
// ─────────────────────────────────────────────────────────────────────
describe('toLegacy', () => {
  it('passes legacy results through unchanged', () => {
    const r: LegacyToolResult = { content: 'x', isError: false }
    expect(toLegacy(r)).toBe(r)
  })

  it('status=success → isError=false', () => {
    expect(toLegacy(ok({ summary: 'done' })).isError).toBe(false)
  })

  it('status=failed → isError=true', () => {
    expect(toLegacy(failed({ summary: 'kaboom' })).isError).toBe(true)
  })

  it('status=cancelled → isError=true', () => {
    expect(toLegacy(cancelled('aborted')).isError).toBe(true)
  })

  it('status=timed_out → isError=true', () => {
    expect(toLegacy(timedOut('slow')).isError).toBe(true)
  })

  it('uses .content first when present', () => {
    const s: StructuredToolResult = {
      status: 'success',
      summary: 'short',
      content: 'long form content for the model',
      stdout: 'should-not-be-used',
    }
    expect(toLegacy(s).content).toBe('long form content for the model')
  })

  it('falls back to stdout+stderr+exitCode when no content', () => {
    const s: StructuredToolResult = {
      status: 'failed',
      summary: 'short',
      stdout: 'OUT',
      stderr: 'ERR',
      exitCode: 2,
    }
    const out = toLegacy(s).content
    expect(out).toContain('Exit code: 2')
    expect(out).toContain('OUT')
    expect(out).toContain('ERR')
  })

  it('falls back to summary when nothing else', () => {
    const s: StructuredToolResult = {
      status: 'success',
      summary: 'just a summary',
    }
    expect(toLegacy(s).content).toBe('just a summary')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Constructors
// ─────────────────────────────────────────────────────────────────────
describe('constructors', () => {
  it('ok() sets sensible defaults', () => {
    const s = ok({ summary: 'x' })
    expect(s.status).toBe('success')
    expect(s.retryable).toBe(false)
  })

  it('failed() defaults exitCode=1', () => {
    const s = failed({ summary: 'x' })
    expect(s.status).toBe('failed')
    expect(s.exitCode).toBe(1)
  })

  it('failed() can override exitCode', () => {
    const s = failed({ summary: 'x', exitCode: 42 })
    expect(s.exitCode).toBe(42)
  })

  it('cancelled() is not retryable', () => {
    expect(cancelled('x').retryable).toBe(false)
  })

  it('timedOut() IS retryable', () => {
    expect(timedOut('x').retryable).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Large-output routing
// ─────────────────────────────────────────────────────────────────────
describe('routeLargeOutput', () => {
  it('returns null for small outputs', () => {
    expect(routeLargeOutput('short', 'a1')).toBeNull()
  })

  it('returns artifact + preview when output exceeds threshold', () => {
    const big = 'x'.repeat(DEFAULT_LARGE_OUTPUT_BYTES + 1000)
    const r = routeLargeOutput(big, 'a1')
    expect(r).not.toBeNull()
    expect(r!.artifact.id).toBe('a1')
    expect(r!.artifact.kind).toBe('log')
    expect(r!.artifact.sizeBytes).toBe(big.length)
    expect(r!.preview).toContain('truncated')
    expect(r!.preview).toContain('a1')
  })

  it('respects custom threshold', () => {
    expect(routeLargeOutput('12345', 'a1', 3)).not.toBeNull()
    expect(routeLargeOutput('12', 'a1', 3)).toBeNull()
  })

  it('preview has head + tail of original', () => {
    const big = 'HEAD_______MIDDLE_______TAIL'
    // Make it big enough to trip the threshold
    const huge = 'A'.repeat(100) + big + 'Z'.repeat(100)
    const r = routeLargeOutput(huge, 'a1', 50)
    expect(r!.preview.startsWith('A')).toBe(true)
    expect(r!.preview.endsWith('Z')).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Bash tool integration: non-zero exit → structured 'failed'
// ─────────────────────────────────────────────────────────────────────
describe('Bash tool emits structured shape', () => {
  it('exit 0 result carries status=success + exitCode=0', async () => {
    const bash = new BashTool()
    const result = await bash.execute({ command: 'echo hello-structured' }, bashCtx()) as AnyToolResult
    const s = toStructured(result)
    expect(s.status).toBe('success')
    expect(s.exitCode).toBe(0)
    expect(s.stdout).toContain('hello-structured')
  })

  it('non-zero exit produces status=failed + exitCode + stdout/stderr retained', async () => {
    const bash = new BashTool()
    const result = await bash.execute(
      { command: 'cat /no/such/path/that/definitely/does/not/exist' },
      bashCtx(),
    ) as AnyToolResult
    const s = toStructured(result)
    expect(s.status).toBe('failed')
    expect(s.exitCode).toBeGreaterThanOrEqual(1)
    // stdout/stderr must be retained (not elided) per spec §六
    expect(s.stdout).toBeDefined()
  })

  it('non-zero exit normalizes to isError=true via toLegacy() (GAP-A fix)', async () => {
    const bash = new BashTool()
    const result = await bash.execute(
      { command: 'sh -c "exit 3"' },
      bashCtx(),
    ) as AnyToolResult
    expect(toLegacy(result).isError).toBe(true)
    expect(toLegacy(result).content).toMatch(/Exit code: 3/)
  })

  it('exit 0 normalizes to isError=false via toLegacy()', async () => {
    const bash = new BashTool()
    const result = await bash.execute(
      { command: 'true' },
      bashCtx(),
    ) as AnyToolResult
    expect(toLegacy(result).isError).toBe(false)
  })

  it('timeout produces status=timed_out', async () => {
    const bash = new BashTool()
    // Spawn a child that we kill externally to simulate timeout path
    const result = await bash.execute(
      { command: 'sleep 5', timeout: 200 },
      bashCtx(),
    ) as AnyToolResult
    const s = toStructured(result)
    expect(s.status).toBe('timed_out')
  }, 5000)
})

// ─────────────────────────────────────────────────────────────────────
// Backward compat: legacy tool shape still works through toLegacy
// ─────────────────────────────────────────────────────────────────────
describe('backward compat with legacy tool shape', () => {
  it('a tool returning {content,isError} still works', () => {
    const legacy: AnyToolResult = { content: 'plain', isError: false }
    const normalized = toLegacy(legacy)
    expect(normalized.content).toBe('plain')
    expect(normalized.isError).toBe(false)
  })
})
