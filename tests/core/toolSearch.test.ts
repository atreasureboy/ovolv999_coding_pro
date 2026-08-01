import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Tool } from '../../src/core/types.js'
import {
  isCoreTool,
  isDeferredTool,
  parseToolName,
  buildToolIndex,
  getToolIndex,
  clearToolIndexCache,
  searchTools,
  searchToolsByExactName,
} from '../../src/core/toolSearch.js'

function tool(name: string, description: string, metadata: Tool['metadata'] = {}): Tool {
  return {
    name,
    metadata,
    definition: {
      type: 'function',
      function: {
        name,
        description,
        parameters: { type: 'object', properties: {} },
      },
    },
    execute: async () => ({ content: '', isError: false }),
  }
}

const BASH = tool('Bash', 'Execute shell commands')
const READ = tool('Read', 'Read a file')
const CUSTOM_DEFERRED = tool(
  'TranslateText',
  'Translate text between languages',
  { searchHint: 'translation i18n languages', shouldDefer: true },
)
const CUSTOM_NON_DEFERRED = tool(
  'QuickNote',
  'Add a quick note to the scratchpad',
)

describe('isCoreTool', () => {
  it('recognizes core tools', () => {
    expect(isCoreTool('Bash')).toBe(true)
    expect(isCoreTool('Read')).toBe(true)
    expect(isCoreTool('Agent')).toBe(true)
  })

  it('rejects non-core tools', () => {
    expect(isCoreTool('TranslateText')).toBe(false)
    expect(isCoreTool('MyCustomTool')).toBe(false)
  })
})

describe('isDeferredTool', () => {
  it('defers tools that opt-in via shouldDefer: true', () => {
    expect(isDeferredTool(CUSTOM_DEFERRED)).toBe(true)
  })

  it('does not defer tools without shouldDefer (default behaviour)', () => {
    expect(isDeferredTool(CUSTOM_NON_DEFERRED)).toBe(false)
    expect(isDeferredTool(BASH)).toBe(false)
    expect(isDeferredTool(READ)).toBe(false)
  })

  it('does not defer tools flagged alwaysLoad', () => {
    const alwaysLoadTool = tool('Foo', 'desc', { alwaysLoad: true })
    expect(isDeferredTool(alwaysLoadTool)).toBe(false)
  })
})

describe('parseToolName', () => {
  it('splits CamelCase names', () => {
    expect(parseToolName('FileRead')).toEqual({
      parts: ['file', 'read'],
      full: 'file read',
      isMcp: false,
    })
  })

  it('splits snake_case names', () => {
    expect(parseToolName('translate_text')).toEqual({
      parts: ['translate', 'text'],
      full: 'translate text',
      isMcp: false,
    })
  })

  it('handles mcp__ prefixed names', () => {
    const parsed = parseToolName('mcp__github__create_issue')
    expect(parsed.isMcp).toBe(true)
    expect(parsed.full).toContain('github')
    expect(parsed.parts).toContain('github')
    expect(parsed.parts).toContain('create')
    expect(parsed.parts).toContain('issue')
  })
})

describe('buildToolIndex', () => {
  beforeEach(() => clearToolIndexCache())
  afterEach(() => clearToolIndexCache())

  it('only indexes tools that opt-in to shouldDefer', () => {
    const explicitDefer = tool('TranslateText', 'Translate', { shouldDefer: true })
    const nonExplicit = tool('QuickNote', 'Note')
    const index = buildToolIndex([BASH, READ, explicitDefer, nonExplicit])
    const names = index.map(e => e.name).sort()
    expect(names).toEqual(['TranslateText'])
  })

  it('attaches tfVector with idf-weighted values', () => {
    const index = buildToolIndex([CUSTOM_DEFERRED])
    expect(index[0]?.tfVector.size).toBeGreaterThan(0)
  })

  it('captures searchHint when provided', () => {
    const index = buildToolIndex([CUSTOM_DEFERRED])
    expect(index[0]?.searchHint).toBe('translation i18n languages')
  })

  it('produces empty index when no deferred tools exist', () => {
    const index = buildToolIndex([BASH, READ])
    expect(index).toEqual([])
  })
})

describe('getToolIndex + clearToolIndexCache', () => {
  beforeEach(() => clearToolIndexCache())
  afterEach(() => clearToolIndexCache())

  it('returns same reference on identical tool roster', () => {
    const tools = [BASH, READ, CUSTOM_DEFERRED]
    const a = getToolIndex(tools)
    const b = getToolIndex(tools)
    expect(a).toBe(b)
  })

  it('rebuilds when tool roster changes', () => {
    const a = getToolIndex([BASH, CUSTOM_DEFERRED])
    const b = getToolIndex([BASH, READ, CUSTOM_DEFERRED])
    expect(a).not.toBe(b)
  })

  it('clears cache explicitly', () => {
    const a = getToolIndex([CUSTOM_DEFERRED])
    clearToolIndexCache()
    const b = getToolIndex([CUSTOM_DEFERRED])
    expect(a).not.toBe(b)
  })
})

describe('searchTools', () => {
  beforeEach(() => clearToolIndexCache())
  afterEach(() => clearToolIndexCache())

  it('returns empty for empty query', () => {
    expect(searchTools('', buildToolIndex([CUSTOM_DEFERRED]))).toEqual([])
    expect(searchTools('   ', buildToolIndex([CUSTOM_DEFERRED]))).toEqual([])
  })

  it('returns empty for empty index', () => {
    expect(searchTools('translate', [])).toEqual([])
  })

  it('finds tools by description keyword', () => {
    const index = buildToolIndex([
      tool('TranslateText', 'Translate text between languages', { shouldDefer: true }),
      tool('CountLines', 'Count lines in a file', { shouldDefer: true }),
    ])
    const results = searchTools('translate language', index)
    expect(results[0]?.name).toBe('TranslateText')
    expect(results[0]?.score).toBeGreaterThan(0)
  })

  it('finds tools by searchHint', () => {
    const index = buildToolIndex([
      tool('TranslateText', 'd', { searchHint: 'translation i18n languages', shouldDefer: true }),
      tool('CountLines', 'Count lines', { shouldDefer: true }),
    ])
    const results = searchTools('i18n', index)
    expect(results[0]?.name).toBe('TranslateText')
  })

  it('ranks better matches higher', () => {
    const index = buildToolIndex([
      tool('Foo', 'translation translation translation', { shouldDefer: true }),
      tool('Bar', 'unrelated', { shouldDefer: true }),
    ])
    const results = searchTools('translation', index)
    expect(results[0]?.name).toBe('Foo')
  })

  it('caps results at limit', () => {
    const tools = [
      tool('TranslateText', 'Translate text between languages', { shouldDefer: true }),
      tool('TranslateSpeech', 'Translate spoken audio', { shouldDefer: true }),
      tool('CountLines', 'Count lines in a file', { shouldDefer: true }),
      tool('CountWords', 'Count words in a file', { shouldDefer: true }),
      tool('FindDuplicates', 'Find duplicate lines', { shouldDefer: true }),
      tool('FormatJSON', 'Format JSON documents', { shouldDefer: true }),
    ]
    const index = buildToolIndex(tools)
    const results = searchTools('translate', index, 2)
    expect(results).toHaveLength(2)
    expect(results[0]?.name.toLowerCase()).toContain('translate')
  })
})

describe('searchToolsByExactName', () => {
  beforeEach(() => clearToolIndexCache())

  it('finds a tool by exact name', () => {
    const index = buildToolIndex([CUSTOM_DEFERRED])
    const found = searchToolsByExactName('TranslateText', index)
    expect(found?.name).toBe('TranslateText')
  })

  it('returns undefined when not found', () => {
    const index = buildToolIndex([CUSTOM_DEFERRED])
    expect(searchToolsByExactName('Unknown', index)).toBeUndefined()
  })
})
