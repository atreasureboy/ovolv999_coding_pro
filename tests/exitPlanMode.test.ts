import { describe, it, expect, vi } from 'vitest'
import { ExitPlanModeTool } from '../src/tools/exitPlanMode.js'
import type { ToolContext } from '../src/core/types.js'

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: '/test', permissionMode: 'auto', ...overrides }
}

describe('ExitPlanModeTool', () => {
  const tool = new ExitPlanModeTool()

  it('has correct name', () => {
    expect(tool.name).toBe('ExitPlanMode')
  })

  it('is concurrency-safe', () => {
    expect(tool.isConcurrencySafe?.()).toBe(true)
  })

  it('rejects empty plan', async () => {
    const result = await tool.execute({ plan: '' }, makeCtx())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('required')
  })

  it('rejects missing plan', async () => {
    const result = await tool.execute({}, makeCtx())
    expect(result.isError).toBe(true)
  })

  it('calls exitPlanMode callback and returns approved message', async () => {
    const mockExit = vi.fn().mockResolvedValue(true)
    const ctx = makeCtx({ exitPlanMode: mockExit })
    const result = await tool.execute({ plan: '## Step 1\nDo thing' }, ctx)
    expect(mockExit).toHaveBeenCalledOnce()
    expect(mockExit).toHaveBeenCalledWith('## Step 1\nDo thing')
    expect(result.isError).toBe(false)
    expect(result.content).toContain('approved')
    expect(result.content).toContain('## Step 1')
  })

  it('returns rejection message when user declines', async () => {
    const mockExit = vi.fn().mockResolvedValue(false)
    const ctx = makeCtx({ exitPlanMode: mockExit })
    const result = await tool.execute({ plan: 'My plan' }, ctx)
    expect(result.isError).toBe(false)
    expect(result.content).toContain('NOT approved')
    expect(result.content).toContain('still in plan mode')
  })

  it('auto-approves when no callback (sub-agent/piped mode)', async () => {
    const result = await tool.execute({ plan: 'My plan' }, makeCtx())
    expect(result.isError).toBe(false)
    expect(result.content).toContain('auto-approved')
    expect(result.content).toContain('My plan')
  })

  it('returns error if callback throws', async () => {
    const mockExit = vi.fn().mockRejectedValue(new Error('UI crashed'))
    const ctx = makeCtx({ exitPlanMode: mockExit })
    const result = await tool.execute({ plan: 'My plan' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('UI crashed')
  })
})
