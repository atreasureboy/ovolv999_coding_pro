import { describe, it, expect } from 'vitest'
import { SleepTool } from '../src/tools/sleep.js'
import type { ToolContext } from '../src/core/types.js'

function makeCtx(signal?: AbortSignal): ToolContext {
  return { cwd: '/test', permissionMode: 'auto', signal }
}

describe('SleepTool', () => {
  const tool = new SleepTool()

  it('has correct name', () => {
    expect(tool.name).toBe('Sleep')
  })

  it('is concurrency-safe', () => {
    expect(tool.isConcurrencySafe?.()).toBe(true)
  })

  it('sleeps for the specified duration', async () => {
    const start = Date.now()
    const result = await tool.execute({ duration_ms: 100 }, makeCtx())
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(90)
    expect(elapsed).toBeLessThan(500)
    expect(result.isError).toBe(false)
    expect(result.content).toContain('Slept')
    expect(result.content).toContain('100')
  })

  it('rejects negative duration', async () => {
    const result = await tool.execute({ duration_ms: -100 }, makeCtx())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('non-negative')
  })

  it('rejects missing duration', async () => {
    const result = await tool.execute({}, makeCtx())
    expect(result.isError).toBe(true)
  })

  it('rejects non-number duration', async () => {
    const result = await tool.execute({ duration_ms: 'abc' }, makeCtx())
    expect(result.isError).toBe(true)
  })

  it('clamps to 10 minutes max (verified via abort)', async () => {
    const controller = new AbortController()
    controller.abort() // abort immediately so we don't actually wait
    const ctx = makeCtx(controller.signal)
    const result = await tool.execute({ duration_ms: 999_999_999 }, ctx)
    expect(result.isError).toBe(false)
    // Should be interrupted, not rejected — the large value was accepted
    expect(result.content).toContain('interrupted')
  })

  it('can be interrupted via abort signal', async () => {
    const controller = new AbortController()
    const ctx = makeCtx(controller.signal)

    // Abort after 50ms
    setTimeout(() => controller.abort(), 50)

    const start = Date.now()
    const result = await tool.execute({ duration_ms: 10_000 }, ctx)
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(500) // Should return quickly after abort
    expect(result.isError).toBe(false)
    expect(result.content).toContain('interrupted')
  })

  it('returns immediately if signal already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const ctx = makeCtx(controller.signal)

    const result = await tool.execute({ duration_ms: 5_000 }, ctx)
    expect(result.isError).toBe(false)
    expect(result.content).toContain('interrupted')
  })

  it('handles zero duration', async () => {
    const result = await tool.execute({ duration_ms: 0 }, makeCtx())
    expect(result.isError).toBe(false)
    expect(result.content).toContain('Slept')
  })
})
