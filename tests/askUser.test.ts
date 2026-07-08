import { describe, it, expect, vi } from 'vitest'
import { AskUserQuestionTool } from '../src/tools/askUser.js'
import type { ToolContext, AskUserQuestionInput } from '../src/core/types.js'

// Helper: create a minimal ToolContext
function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: '/test',
    permissionMode: 'auto',
    ...overrides,
  }
}

// Helper: create valid question input
function makeQuestion(overrides: Partial<AskUserQuestionInput> = {}): AskUserQuestionInput {
  return {
    question: 'Which approach?',
    header: 'Approach',
    options: [
      { label: 'Option A', description: 'First approach' },
      { label: 'Option B', description: 'Second approach' },
    ],
    ...overrides,
  }
}

// ── validateQuestions (via execute error messages) ──────────────────────────

describe('AskUserQuestionTool — validation', () => {
  const tool = new AskUserQuestionTool()

  it('rejects empty questions array', async () => {
    const result = await tool.execute({ questions: [] }, makeCtx())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('non-empty array')
  })

  it('rejects more than 4 questions', async () => {
    const qs = Array.from({ length: 5 }, (_, i) =>
      makeQuestion({ question: `Q${i}?`, header: `H${i}` }),
    )
    const result = await tool.execute({ questions: qs }, makeCtx())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Maximum 4')
  })

  it('rejects question without question text', async () => {
    const result = await tool.execute(
      { questions: [{ header: 'H', options: [{ label: 'A', description: 'd' }, { label: 'B', description: 'd' }] }] },
      makeCtx(),
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('"question"')
  })

  it('rejects question without header', async () => {
    const result = await tool.execute(
      { questions: [{ question: 'Q?', options: [{ label: 'A', description: 'd' }, { label: 'B', description: 'd' }] }] },
      makeCtx(),
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('"header"')
  })

  it('rejects fewer than 2 options', async () => {
    const result = await tool.execute(
      { questions: [makeQuestion({ options: [{ label: 'A', description: 'd' }] })] },
      makeCtx(),
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('2-4 options')
  })

  it('rejects more than 4 options', async () => {
    const result = await tool.execute(
      { questions: [makeQuestion({ options: [
        { label: 'A', description: 'd' }, { label: 'B', description: 'd' },
        { label: 'C', description: 'd' }, { label: 'D', description: 'd' },
        { label: 'E', description: 'd' },
      ] })] },
      makeCtx(),
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('2-4 options')
  })

  it('rejects duplicate question texts', async () => {
    const qs = [
      makeQuestion({ question: 'Same?', header: 'H1' }),
      makeQuestion({ question: 'Same?', header: 'H2' }),
    ]
    const result = await tool.execute({ questions: qs }, makeCtx())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Duplicate question')
  })

  it('rejects duplicate option labels within a question', async () => {
    const result = await tool.execute(
      { questions: [makeQuestion({ options: [
        { label: 'Dup', description: 'd' }, { label: 'Dup', description: 'd2' },
      ] })] },
      makeCtx(),
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Duplicate option label')
  })

  it('rejects option without label', async () => {
    const result = await tool.execute(
      { questions: [makeQuestion({ options: [
        { description: 'd' } as unknown as { label: string; description: string },
        { label: 'B', description: 'd' },
      ] })] },
      makeCtx(),
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('"label"')
  })
})

// ── Execute with callback ───────────────────────────────────────────────────

describe('AskUserQuestionTool — execute with callback', () => {
  const tool = new AskUserQuestionTool()

  it('calls the callback and returns formatted answers', async () => {
    const mockHandler = vi.fn().mockResolvedValue({ 'Which approach?': 'Option A' })
    const ctx = makeCtx({ askUserQuestion: mockHandler })
    const result = await tool.execute(
      { questions: [makeQuestion()] },
      ctx,
    )
    expect(mockHandler).toHaveBeenCalledOnce()
    expect(mockHandler).toHaveBeenCalledWith([makeQuestion()])
    expect(result.isError).toBe(false)
    expect(result.content).toContain('Which approach?')
    expect(result.content).toContain('Option A')
  })

  it('handles multiple questions', async () => {
    const mockHandler = vi.fn().mockResolvedValue({
      'Q1?': 'A1',
      'Q2?': 'A2',
    })
    const ctx = makeCtx({ askUserQuestion: mockHandler })
    const result = await tool.execute(
      { questions: [
        makeQuestion({ question: 'Q1?', header: 'H1' }),
        makeQuestion({ question: 'Q2?', header: 'H2' }),
      ] },
      ctx,
    )
    expect(result.isError).toBe(false)
    expect(result.content).toContain('Q1?')
    expect(result.content).toContain('A1')
    expect(result.content).toContain('Q2?')
    expect(result.content).toContain('A2')
  })

  it('returns error if callback throws', async () => {
    const mockHandler = vi.fn().mockRejectedValue(new Error('User cancelled'))
    const ctx = makeCtx({ askUserQuestion: mockHandler })
    const result = await tool.execute(
      { questions: [makeQuestion()] },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('User cancelled')
  })
})

// ── Execute without callback (fallback) ─────────────────────────────────────

describe('AskUserQuestionTool — fallback without callback', () => {
  const tool = new AskUserQuestionTool()

  it('returns graceful fallback when no callback provided', async () => {
    const result = await tool.execute(
      { questions: [makeQuestion()] },
      makeCtx(), // no askUserQuestion
    )
    expect(result.isError).toBe(false)
    expect(result.content).toContain('non-interactive mode')
    expect(result.content).toContain('Which approach?')
  })

  it('fallback includes all question texts', async () => {
    const result = await tool.execute(
      { questions: [
        makeQuestion({ question: 'First?', header: 'H1' }),
        makeQuestion({ question: 'Second?', header: 'H2' }),
      ] },
      makeCtx(),
    )
    expect(result.content).toContain('First?')
    expect(result.content).toContain('Second?')
  })
})

// ── Tool metadata ───────────────────────────────────────────────────────────

describe('AskUserQuestionTool — metadata', () => {
  const tool = new AskUserQuestionTool()

  it('has correct name', () => {
    expect(tool.name).toBe('AskUserQuestion')
  })

  it('is not concurrency-safe (requires user interaction)', () => {
    expect(tool.isConcurrencySafe?.()).toBe(false)
  })

  it('has a valid tool definition', () => {
    expect(tool.definition.type).toBe('function')
    expect(tool.definition.function.name).toBe('AskUserQuestion')
    expect(tool.definition.function.parameters.properties).toHaveProperty('questions')
  })
})
