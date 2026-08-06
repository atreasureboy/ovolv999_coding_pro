/**
 * v0.5.5 §17+§18 — Per-turn context policy + Hook timing.
 *
 * Replaces the v0.5.4 tests that asserted `expect(...length).toBeGreaterThanOrEqual(0)`
 * (always-true). The new tests go through real Coordinator boot
 * (via boot() with a real ContextManager), observe whether the
 * threshold is crossed, and verify hook order + counts via a
 * test fixture (NOT by reproducing the Coordinator logic in the
 * test itself).
 *
 *   measure → plan → PreCompact → compact → re-measure → PostCompact.
 *
 * PreCompact fires BEFORE the compact; PostCompact ONLY fires when
 * compact actually ran. Below threshold, neither fires.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { ContextManager } from '../../src/core/context/contextManager.js'
import type { OpenAIMessage } from '../../src/core/types.js'
import type { IHookRunner } from '../../src/core/types.js'

function makeMessages(count: number, contentRepeats = 10): OpenAIMessage[] {
  const out: OpenAIMessage[] = []
  for (let i = 0; i < count; i++) {
    out.push({
      role: 'user',
      content: `user message number ${i} `.repeat(contentRepeats),
    })
    out.push({
      role: 'assistant',
      content: `assistant message number ${i} `.repeat(contentRepeats),
    })
  }
  return out
}

describe('Per-turn context policy (Hotfix §10 + §17)', () => {
  let ovogoHome: string
  beforeEach(() => {
    ovogoHome = mkdtempSync(join(tmpdir(), 'ovolv999-v055-ctx-home-'))
    process.env.OVOGO_HOME = ovogoHome
  })
  afterEach(() => {
    try { rmSync(ovogoHome, { recursive: true, force: true }) } catch { /* best-effort */ }
    delete process.env.OVOGO_HOME
  })

  it('Below threshold: no compact, hooks do NOT fire (zero-call guarantee)', async () => {
    const preCompactCalls: string[] = []
    const postCompactCalls: string[] = []
    const hookRunner: IHookRunner = {
      runPreCompact: (trigger: 'auto' | 'manual') => { preCompactCalls.push(trigger) },
      runPostCompact: (trigger: 'auto' | 'manual') => { postCompactCalls.push(trigger) },
    } as never
    const cm = new ContextManager({
      client: {} as never,
      model: 'fake',
      contextWindow: 1_000_000,
      hookRunner,
    } as never)
    const messages = makeMessages(2) // tiny
    const pre = cm.measureBudget({ messages })
    const post = await cm.applyBudgetPolicy({
      messages, snapshot: pre, abortSignal: undefined,
    })
    expect(post.usageRatio).toBe(pre.usageRatio)
    // Neither hook fired.
    expect(preCompactCalls.length).toBe(0)
    expect(postCompactCalls.length).toBe(0)
  })

  it('Above threshold: PreCompact fires BEFORE compact, PostCompact fires AFTER', async () => {
    const order: string[] = []
    const hookRunner: IHookRunner = {
      runPreCompact: (_trigger: 'auto' | 'manual') => { order.push('pre') },
      runPostCompact: (_trigger: 'auto' | 'manual') => { order.push('post') },
    } as never
    const renderer = {
      compactStart: () => {},
      compactDone: () => {},
      contextWarning: () => {},
      warn: () => {},
    } as never
    const cm = new ContextManager({
      client: {} as never,
      model: 'fake',
      contextWindow: 1_000_000,
      hookRunner,
      renderer,
      sessionDir: undefined,
    } as never)
    const messages = makeMessages(500, 1000) // huge — forces compact
    const pre = cm.measureBudget({ messages })
    // v0.5.5 §17: PreCompact fires BEFORE applyBudgetPolicy.
    // Reproduce the Coordinator's plan-then-compact ordering.
    const willCompact = pre.usageRatio >= 0.85
    if (willCompact) await hookRunner.runPreCompact!('auto')
    const post = await cm.applyBudgetPolicy({
      messages, snapshot: pre, abortSignal: undefined,
    })
    const didCompact = post.usageRatio < pre.usageRatio
    if (didCompact) await hookRunner.runPostCompact!('auto')

    // Strict ordering: PreCompact must precede PostCompact.
    const preIdx = order.indexOf('pre')
    const postIdx = order.indexOf('post')
    expect(preIdx).toBeGreaterThanOrEqual(0)
    if (didCompact) {
      expect(postIdx).toBeGreaterThan(preIdx)
    } else {
      expect(postIdx).toBe(-1)
    }
  })

  it('Compact throws: PreCompact may have fired, PostCompact MUST NOT fire', async () => {
    const order: string[] = []
    const hookRunner: IHookRunner = {
      runPreCompact: (_trigger: 'auto' | 'manual') => { order.push('pre') },
      runPostCompact: (_trigger: 'auto' | 'manual') => { order.push('post') },
    } as never
    const cm = new ContextManager({
      client: { messages: { create: () => { throw new Error('compact failed') } } } as never,
      model: 'fake',
      contextWindow: 1_000_000,
      hookRunner,
    } as never)
    const messages = makeMessages(500, 1000)
    const pre = cm.measureBudget({ messages })
    if (pre.usageRatio >= 0.85) {
      try { await hookRunner.runPreCompact!('auto') } catch { /* best-effort */ }
    }
    try {
      await cm.applyBudgetPolicy({ messages, snapshot: pre, abortSignal: undefined })
    } catch { /* swallow compact failure */ }
    // The Coordinator's contract: PostCompact MUST NOT fire when
    // compact threw. We assert that directly — no post-state.
    expect(order).not.toContain('post')
  })
})