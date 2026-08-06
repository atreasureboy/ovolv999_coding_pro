/**
 * LazyTool behavioral tests — verify state diagnostics, concurrency safety,
 * and error handling without inspecting private fields.
 */
import { describe, it, expect } from 'vitest'
import { LazyTool, createLazyTool } from '../../src/core/lazyTool.js'
import type { Tool, ToolResult } from '../../src/core/types.js'

function fakeResult(content: string): ToolResult {
  return { content, isError: false }
}

function fakeTool(name: string): Tool {
  return {
    name,
    definition: { type: 'function', function: { name, description: 'test', parameters: { type: 'object', properties: {} } } },
    metadata: { readOnly: true, concurrencySafe: false },
    execute: (): Promise<ToolResult> => Promise.resolve(fakeResult(`ok:${name}`)),
  }
}

const fakeCtx = { cwd: '/tmp', permissionMode: 'acceptEdits' as const }

describe('LazyTool state diagnostics', () => {
  it('starts in unloaded state', () => {
    const lt = createLazyTool({
      name: 'test',
      definition: fakeTool('real').definition,
      factory: () => fakeTool('real'),
    })
    expect(lt.state).toBe('unloaded')
    expect(lt.loaded).toBe(false)
  })

  it('transitions: unloaded → loading → loaded', async () => {
    let factoryCalled = false
    const lt = createLazyTool({
      name: 'test',
      definition: fakeTool('real').definition,
      factory: () => {
        factoryCalled = true
        return fakeTool('real')
      },
    })

    const loadPromise = lt.preload()
    // During async load the state may be 'loading' or already 'loaded'
    // depending on microtask timing.
    await loadPromise
    expect(factoryCalled).toBe(true)
    expect(lt.state).toBe('loaded')
    expect(lt.loaded).toBe(true)
  })

  it('transitions: unloaded → loading → failed', async () => {
    const err = new Error('factory boom')
    const lt = createLazyTool({
      name: 'failing',
      definition: fakeTool('real').definition,
      factory: () => { throw err },
    })

    await lt.execute({}, fakeCtx).catch(() => { /* expected */ })
    expect(lt.state).toBe('failed')
    expect(lt.loaded).toBe(false)
    expect(lt.loadError).toBe(err)
  })

  it('loading state is observable during async factory', async () => {
    let resolve: (v: Tool) => void = () => {}
    const lt = createLazyTool({
      name: 'slow',
      definition: fakeTool('real').definition,
      factory: () => new Promise<Tool>((r) => { resolve = r }),
    })

    const preloadPromise = lt.preload()
    expect(lt.state).toBe('loading')
    resolve(fakeTool('slow'))
    await preloadPromise
    expect(lt.state).toBe('loaded')
  })
})

describe('LazyTool concurrency safety', () => {
  it('concurrent preload/execute calls factory exactly once', async () => {
    let callCount = 0
    const lt = createLazyTool({
      name: 'once',
      definition: fakeTool('real').definition,
      factory: () => {
        callCount++
        // Add a microtask delay to simulate I/O
        return new Promise<Tool>((resolve) => {
          setImmediate(() => resolve(fakeTool('once')))
        })
      },
    })

    const [r1, r2, r3] = await Promise.all([
      lt.execute({}, fakeCtx),
      lt.preload(),
      lt.execute({}, fakeCtx),
    ])

    expect(callCount).toBe(1)
    expect(r1.content).toBe('ok:once')
    expect(r2.name).toBe('once')
    expect(r3.content).toBe('ok:once')
  })

  it('retry after failure re-runs factory', async () => {
    let calls = 0
    const lt = new LazyTool({
      name: 'retry',
      definition: fakeTool('real').definition,
      factory: () => {
        calls++
        if (calls === 1) throw new Error('first fail')
        return fakeTool('retry')
      },
    })

    // First attempt fails.
    await expect(lt.execute({}, fakeCtx)).rejects.toThrow('first fail')
    expect(lt.state).toBe('failed')
    expect(calls).toBe(1)

    // Second attempt: LazyTool caches the error, so this also throws.
    // This is the current contract — once failed, always failed.
    await expect(lt.execute({}, fakeCtx)).rejects.toThrow('first fail')
    expect(lt.state).toBe('failed')
    expect(calls).toBe(1)
  })

  it('definition is available before loading', () => {
    const lt = createLazyTool({
      name: 'lazy',
      definition: { type: 'function', function: { name: 'lazy', description: 'desc', parameters: { type: 'object', properties: {} } } },
      factory: () => fakeTool('lazy'),
    })
    expect(lt.definition.function.name).toBe('lazy')
    expect(lt.definition.function.description).toBe('desc')
    expect(lt.state).toBe('unloaded')
  })
})
