import { describe, it, expect } from 'vitest'
import { sequential, createChildAbortController } from '../src/core/concurrency.js'
import { setTimeout as delay } from 'timers/promises'

describe('sequential', () => {
  it('executes calls in arrival order (no interleaving)', async () => {
    const log: string[] = []
    const fn = sequential(async (id: string): Promise<string> => {
      log.push(`start:${id}`)
      await delay(10)
      log.push(`end:${id}`)
      return id
    })

    // Fire 3 calls concurrently
    const p1 = fn('a')
    const p2 = fn('b')
    const p3 = fn('c')

    const results = await Promise.all([p1, p2, p3])
    expect(results).toEqual(['a', 'b', 'c'])

    // Should be strictly sequential: start:a, end:a, start:b, end:b, start:c, end:c
    expect(log).toEqual([
      'start:a', 'end:a',
      'start:b', 'end:b',
      'start:c', 'end:c',
    ])
  })

  it('does not block subsequent calls after a failure', () => {
    let callCount = 0
    const fn = sequential((shouldFail: boolean): Promise<string> => {
      callCount++
      if (shouldFail) return Promise.reject(new Error('boom'))
      return Promise.resolve('ok')
    })

    // First call fails
    return expect(fn(true)).rejects.toThrow('boom').then(async () => {
      // Second call should still work
      const result = await fn(false)
      expect(result).toBe('ok')
      expect(callCount).toBe(2)
    })
  })

  it('preserves return values', () => {
    const fn = sequential((x: number): Promise<number> => Promise.resolve(x * 2))
    return Promise.all([
      expect(fn(5)).resolves.toBe(10),
      expect(fn(3)).resolves.toBe(6),
    ])
  })
})

describe('createChildAbortController', () => {
  it('creates an independent controller when no parent', () => {
    const child = createChildAbortController()
    expect(child.signal.aborted).toBe(false)
    child.abort()
    expect(child.signal.aborted).toBe(true)
  })

  it('propagates parent abort to child', () => {
    const parent = new AbortController()
    const child = createChildAbortController(parent.signal)

    expect(child.signal.aborted).toBe(false)
    parent.abort()
    expect(child.signal.aborted).toBe(true)
  })

  it('child is already aborted if parent was already aborted', () => {
    const parent = new AbortController()
    parent.abort('parent_reason')

    const child = createChildAbortController(parent.signal)
    expect(child.signal.aborted).toBe(true)
  })

  it('does not propagate child abort to parent', () => {
    const parent = new AbortController()
    const child = createChildAbortController(parent.signal)

    child.abort()
    expect(child.signal.aborted).toBe(true)
    expect(parent.signal.aborted).toBe(false)
  })

  it('removes parent listener after child abort (no leak)', () => {
    const parent = new AbortController()
    const child = createChildAbortController(parent.signal)

    child.abort()

    // After child abort, parent should still work independently
    expect(parent.signal.aborted).toBe(false)

    // Parent can still be aborted normally
    parent.abort()
    expect(parent.signal.aborted).toBe(true)
  })

  it('supports nested child controllers', () => {
    const grandparent = new AbortController()
    const parent = createChildAbortController(grandparent.signal)
    const child = createChildAbortController(parent.signal)

    expect(child.signal.aborted).toBe(false)
    grandparent.abort()
    expect(child.signal.aborted).toBe(true)
    expect(parent.signal.aborted).toBe(true)
  })
})
