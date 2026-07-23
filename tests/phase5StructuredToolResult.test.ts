/**
 * Phase 5 (five_goal §九 P1-4, P1-5):
 *
 * P1-4: StructuredToolResult is the unified internal shape. The legacy
 *       {content, isError} survives only as a provider-message
 *       serialization layer via toLegacy(). Internal consumers must
 *       not parse content to determine success/failure.
 *
 * P1-5: Bash non-zero exit code is ALWAYS status='failed' unless the
 *       caller explicitly listed it in acceptable_exit_codes. Even
 *       then, the structured status reflects what happened — the
 *       isError flag is the only thing that flips.
 */

import { describe, it, expect } from 'vitest'
import { BashTool } from '../src/tools/bash.js'
import {
  isStructuredResult,
  toStructured,
  toLegacy,
  ok,
  failed,
  cancelled,
  timedOut,
  type AnyToolResult,
} from '../src/core/structuredToolResult.js'
import type { ToolContext } from '../src/core/types.js'

function ctx(): ToolContext {
  return { cwd: '/tmp', permissionMode: 'auto' } as never
}

// ─────────────────────────────────────────────────────────────────────
// P1-4: Structured shape is the unified internal type
// ─────────────────────────────────────────────────────────────────────
describe('P1-4: StructuredToolResult normalizers', () => {
  it('isStructuredResult() discriminates the two shapes', () => {
    expect(isStructuredResult({ content: 'x', isError: false })).toBe(false)
    expect(isStructuredResult({ status: 'success', summary: 'ok' })).toBe(true)
  })

  it('toStructured() maps legacy success → status:success', () => {
    const s = toStructured({ content: 'did X', isError: false })
    expect(s.status).toBe('success')
    expect(s.summary).toBe('did X')
  })

  it('toStructured() maps legacy error → status:failed', () => {
    const s = toStructured({ content: 'boom', isError: true })
    expect(s.status).toBe('failed')
    expect(s.summary).toBe('boom')
  })

  it('toLegacy() maps structured success → isError:false', () => {
    const r = toLegacy(ok({ summary: 'fine', stdout: 'data' }))
    expect(r.isError).toBe(false)
    expect(r.content).toMatch(/data/)
  })

  it('toLegacy() maps structured failed/cancelled/timed_out → isError:true', () => {
    expect(toLegacy(failed({ summary: 'f' })).isError).toBe(true)
    expect(toLegacy(cancelled('c')).isError).toBe(true)
    expect(toLegacy(timedOut('t')).isError).toBe(true)
  })

  it('toLegacy() preserves content override when set explicitly', () => {
    const r = toLegacy({
      status: 'failed',
      summary: 'short',
      content: 'long content for the model',
    })
    expect(r.content).toBe('long content for the model')
  })

  it('round-trip: legacy → structured → legacy preserves isError + content', () => {
    const original = { content: 'hello', isError: true }
    const roundTripped = toLegacy(toStructured(original))
    expect(roundTripped.content).toBe('hello')
    expect(roundTripped.isError).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────
// P1-5: Bash exit code semantics
// ─────────────────────────────────────────────────────────────────────
describe('P1-5: Bash exit code → status mapping', () => {
  it('exit 0 → status:success, isError:false', async () => {
    const t = new BashTool()
    const out = await t.execute({ command: 'true' }, ctx()) as ToolResultLike & { status?: string; exitCode?: number }
    expect(out.isError).toBe(false)
    expect(out.status).toBe('success')
    expect(out.exitCode).toBe(0)
  })

  it('exit 1 (default) → status:failed, isError:true', async () => {
    const t = new BashTool()
    const out = await t.execute({ command: 'false' }, ctx()) as ToolResultLike & { status?: string; exitCode?: number }
    expect(out.isError).toBe(true)
    expect(out.status).toBe('failed')
    expect(out.exitCode).toBe(1)
  })

  it('exit 2 with no allow-list → status:failed', async () => {
    const t = new BashTool()
    const out = await t.execute({ command: 'exit 2' }, ctx()) as ToolResultLike & { status?: string; exitCode?: number }
    expect(out.isError).toBe(true)
    expect(out.status).toBe('failed')
    expect(out.exitCode).toBe(2)
  })

  it('exit code in acceptable_exit_codes → status:success, isError:false', async () => {
    const t = new BashTool()
    const out = await t.execute(
      { command: 'exit 1', acceptable_exit_codes: [0, 1] },
      ctx(),
    ) as ToolResultLike & { status?: string; exitCode?: number; isError?: boolean }
    expect(out.isError).toBe(false)
    expect(out.status).toBe('success')
    expect(out.exitCode).toBe(1)
  })

  it('non-zero exit NOT in acceptable_exit_codes → still failed', async () => {
    const t = new BashTool()
    const out = await t.execute(
      { command: 'exit 2', acceptable_exit_codes: [0, 1] },
      ctx(),
    ) as ToolResultLike & { status?: string; exitCode?: number }
    expect(out.isError).toBe(true)
    expect(out.status).toBe('failed')
    expect(out.exitCode).toBe(2)
  })

  it('malformed acceptable_exit_codes falls back to [0]', async () => {
    const t = new BashTool()
    const out = await t.execute({ command: 'exit 1', acceptable_exit_codes: 'oops' }, ctx()) as ToolResultLike & { status?: string }
    expect(out.status).toBe('failed')
  })

  it('grep -l with no matches exits 1 — allow-list treats as success', async () => {
    const t = new BashTool()
    // grep -l exits 1 when no matches found (benign).
    const out = await t.execute(
      { command: "grep -l 'nonexistent-pattern-xyz' /dev/null", acceptable_exit_codes: [0, 1] },
      ctx(),
    ) as ToolResultLike & { status?: string; isError?: boolean }
    expect(out.isError).toBe(false)
    expect(out.status).toBe('success')
  })
})

// Helper re-export to satisfy the local ToolResult typing above.
type ToolResultLike = { content: string; isError?: boolean; status?: string; exitCode?: number }
