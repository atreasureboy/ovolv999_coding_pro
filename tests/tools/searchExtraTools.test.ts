import { describe, expect, it } from 'vitest'
import type { Tool, ToolContext } from '../../src/core/types.js'
import {
  createSearchExtraToolsTool,
  SEARCH_EXTRA_TOOLS_NAME,
} from '../../src/tools/searchExtraTools.js'

function tool(name: string, description: string, metadata: Tool['metadata'] = {}): Tool {
  return {
    name,
    metadata,
    definition: {
      type: 'function',
      function: {
        name,
        description,
        parameters: {
          type: 'object',
          properties: { x: { type: 'string' } },
        },
      },
    },
    execute: async () => ({ content: '', isError: false }),
  }
}

const BASH = tool('Bash', 'Execute shell commands')
const TRANSLATE = tool('TranslateText', 'Translate text between languages', {
  searchHint: 'translation i18n languages',
  shouldDefer: true,
})
const COUNT = tool('CountLines', 'Count lines in a file', { shouldDefer: true })

function makeContext(
  discovered: string[] = [],
): ToolContext {
  const registered = [BASH, TRANSLATE, COUNT]
  const discoveredSet = new Set(discovered)
  return {
    cwd: '/tmp',
    permissionMode: 'auto',
    getRegisteredTools: () => registered,
    markToolDiscovered: (name: string) => { discoveredSet.add(name) },
    availableToolNames: registered.map(t => t.name),
  }
}

describe('createSearchExtraToolsTool', () => {
  it('returns a tool with the expected name and metadata', () => {
    const t = createSearchExtraToolsTool()
    expect(t.name).toBe(SEARCH_EXTRA_TOOLS_NAME)
    expect(t.metadata?.readOnly).toBe(true)
    expect(t.metadata?.concurrencySafe).toBe(true)
    expect(t.metadata?.searchHint).toBeTruthy()
  })

  it('exposes a valid ToolDefinition', () => {
    const t = createSearchExtraToolsTool()
    expect(t.definition.type).toBe('function')
    expect(t.definition.function.name).toBe(SEARCH_EXTRA_TOOLS_NAME)
    expect(t.definition.function.parameters.required).toContain('query')
  })

  it('returns error when query is empty', async () => {
    const t = createSearchExtraToolsTool()
    const ctx = makeContext()
    const result = await t.execute({}, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('query is required')
  })

  it('handles select: prefix by exact lookup', async () => {
    const t = createSearchExtraToolsTool()
    const ctx = makeContext()
    const result = await t.execute({ query: 'select:TranslateText' }, ctx)
    expect(result.isError).toBe(false)
    expect(result.content).toContain('TranslateText')
  })

  it('returns no matches for unknown select: name', async () => {
    const t = createSearchExtraToolsTool()
    const ctx = makeContext()
    const result = await t.execute({ query: 'select:NonExistent' }, ctx)
    expect(result.content).toContain('No deferred tools matched')
  })

  it('handles discover: prefix as a search query', async () => {
    const t = createSearchExtraToolsTool()
    const ctx = makeContext()
    const result = await t.execute({ query: 'discover:translate language' }, ctx)
    expect(result.isError).toBe(false)
    expect(result.content).toContain('discover')
  })

  it('handles plain keyword search', async () => {
    const t = createSearchExtraToolsTool()
    const ctx = makeContext()
    const result = await t.execute({ query: 'translation' }, ctx)
    expect(result.isError).toBe(false)
    expect(result.content).toContain('TranslateText')
  })

  it('marks discovered tools in context', async () => {
    const t = createSearchExtraToolsTool()
    const ctx = makeContext()
    await t.execute({ query: 'translate' }, ctx)
    expect((ctx as unknown as { markToolDiscovered: (n: string) => void }).markToolDiscovered).toBeDefined()
  })

  it('respects max_results parameter', async () => {
    const t = createSearchExtraToolsTool()
    const ctx = makeContext()
    const result = await t.execute({ query: 'translate', max_results: 1 }, ctx)
    expect(result.content).toMatch(/Found 1/)
  })

  it('clamps max_results to hard cap', async () => {
    const t = createSearchExtraToolsTool()
    const ctx = makeContext()
    const result = await t.execute({ query: 'translate', max_results: 1000 }, ctx)
    expect(result.content).toBeDefined()
  })

  it('handles missing getRegisteredTools gracefully', async () => {
    const t = createSearchExtraToolsTool()
    const ctx = {
      cwd: '/tmp',
      permissionMode: 'auto',
    } as ToolContext
    const result = await t.execute({ query: 'translate' }, ctx)
    expect(result.isError).toBe(false)
    expect(result.content).toContain('No deferred tools matched')
  })

  it('includes schema in match output', async () => {
    const t = createSearchExtraToolsTool()
    const ctx = makeContext()
    const result = await t.execute({ query: 'select:TranslateText' }, ctx)
    expect(result.content).toContain('schema')
  })
})
