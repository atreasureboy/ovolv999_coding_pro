import { describe, it, expect } from 'vitest'
import { ToolRegistry } from '../src/core/toolRuntime/toolRegistry.js'
import type { Tool } from '../src/core/types.js'

function makeTool(name: string): Tool {
  return {
    name,
    definition: {
      type: 'function' as const,
      function: { name, description: '', parameters: { type: 'object', properties: {} } },
    },
    execute: async () => ({ content: 'ok', isError: false }),
  }
}

describe('ToolRegistry', () => {
  it('registers and looks up tools by name', () => {
    const registry = new ToolRegistry()
    const read = makeTool('Read')
    const bash = makeTool('Bash')
    registry.registerMany([read, bash])

    expect(registry.get('Read')).toBe(read)
    expect(registry.get('Bash')).toBe(bash)
    expect(registry.get('Nonexistent')).toBeUndefined()
  })

  it('getAll returns all registered tools', () => {
    const registry = new ToolRegistry()
    registry.registerMany([makeTool('Read'), makeTool('Grep'), makeTool('Glob')])

    expect(registry.getAll()).toHaveLength(3)
    expect(registry.getAll().map(t => t.name).sort()).toEqual(['Glob', 'Grep', 'Read'])
  })

  it('first-registered wins on name collision', () => {
    const warnings: string[] = []
    const fakeRenderer = { warn: (msg: string) => warnings.push(msg) }
    const registry = new ToolRegistry(fakeRenderer as never)

    const base = makeTool('Read')
    const moduleTool = makeTool('Read')
    registry.register(base)
    registry.register(moduleTool)

    expect(registry.get('Read')).toBe(base)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toMatch(/name collision/)
  })

  it('reset clears and re-registers base + module tools', () => {
    const registry = new ToolRegistry()
    registry.registerMany([makeTool('Old1'), makeTool('Old2')])
    expect(registry.size).toBe(2)

    registry.reset([makeTool('Base1'), makeTool('Base2')], [makeTool('Module1')])
    expect(registry.size).toBe(3)
    expect(registry.get('Base1')).toBeDefined()
    expect(registry.get('Module1')).toBeDefined()
    expect(registry.get('Old1')).toBeUndefined()
  })

  it('size tracks the number of unique tools', () => {
    const registry = new ToolRegistry()
    expect(registry.size).toBe(0)
    registry.register(makeTool('Read'))
    expect(registry.size).toBe(1)
    registry.register(makeTool('Read')) // collision, not added
    expect(registry.size).toBe(1)
  })
})
