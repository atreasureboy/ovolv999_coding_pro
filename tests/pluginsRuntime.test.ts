import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PluginsModule } from '../src/modules/plugins.js'
import type { ModuleBootContext } from '../src/core/module.js'

let cwd = ''

function makePlugin(name: string, manifest: Record<string, unknown>, files: Record<string, string>): void {
  const dir = join(cwd, '.ovolv999', 'plugins', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name, version: '1.0.0', enabled: true, ...manifest }), 'utf8')
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(dir, file), content, 'utf8')
  }
}

function bootCtx(): ModuleBootContext {
  return { cwd, config: { cwd } } as unknown as ModuleBootContext
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'ovogo-plugins-runtime-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

describe('PluginsModule runtime loading', () => {
  it('does not execute project plugins before workspace trust is granted', async () => {
    makePlugin('untrusted', { provides: { tools: ['tools.js'] } }, {
      'tools.js': `throw new Error('must not execute')`,
    })
    const result = await new PluginsModule().boot(bootCtx())
    expect(result.tools).toBeUndefined()
  })

  it('imports plugin tools and returns them for engine registration', async () => {
    makePlugin('demo', { provides: { tools: ['tools.js'] } }, {
      'tools.js': `
const tool = {
  name: 'demo_hello',
  definition: { type: 'function', function: { name: 'demo_hello', description: 'says hi', parameters: { type: 'object', properties: {} } } },
  async execute(input, context) {
    return { content: 'hello from plugin in ' + context.cwd, isError: false }
  },
}
module.exports = { tools: [tool] }
`,
    })

    const module = new PluginsModule({ trustProjectCode: true })
    const result = await module.boot(bootCtx())
    expect(result.tools).toHaveLength(1)
    const tool = result.tools![0]
    expect(tool.name).toBe('demo_hello')
    const out = await tool.execute({}, { cwd, permissionMode: 'auto' } as never)
    expect(out.content).toContain('hello from plugin')
  })

  it('supports default export shapes (single tool, array, factory)', async () => {
    makePlugin('shapes', { provides: { tools: ['tools.js'] } }, {
      'tools.js': `
function mkTool(n) {
  return {
    name: n,
    definition: { type: 'function', function: { name: n, description: n, parameters: { type: 'object', properties: {} } } },
    async execute() { return { content: n, isError: false } },
  }
}
module.exports = () => [mkTool('shape_a'), mkTool('shape_b')]
`,
    })
    const result = await new PluginsModule({ trustProjectCode: true }).boot(bootCtx())
    expect((result.tools ?? []).map((t) => t.name).sort()).toEqual(['shape_a', 'shape_b'])
  })

  it('registers plugin slash commands', async () => {
    makePlugin('cmd', { provides: { commands: ['commands.js'] } }, {
      'commands.js': `
module.exports = [{
  name: 'pluginhello',
  description: 'hello from plugin',
  handler: () => ({ type: 'text', value: 'hi from plugin command' }),
}]
`,
    })
    const result = await new PluginsModule({ trustProjectCode: true }).boot(bootCtx())
    expect(result.tools ?? []).toHaveLength(0)

    const { getCommand } = await import('../src/commands/index.js')
    const cmd = getCommand('pluginhello')
    expect(cmd).toBeDefined()
    const out = await cmd!.handler('', { cwd } as never)
    expect(out).toEqual({ type: 'text', value: 'hi from plugin command' })
  })

  it('skips disabled plugins', async () => {
    makePlugin('off', { enabled: false, provides: { tools: ['tools.js'] } }, {
      'tools.js': `module.exports = { tools: [{ name: 'off_tool', definition: {}, async execute() { return { content: '', isError: false } } }] }`,
    })
    const result = await new PluginsModule({ trustProjectCode: true }).boot(bootCtx())
    expect(result.tools ?? []).toHaveLength(0)
  })

  it('isolates broken plugins without failing boot', async () => {
    makePlugin('broken', { provides: { tools: ['tools.js'] } }, {
      'tools.js': `throw new Error('plugin exploded')`,
    })
    makePlugin('fine', { provides: { tools: ['tools.js'] } }, {
      'tools.js': `module.exports = { tools: [{
        name: 'fine_tool',
        definition: { type: 'function', function: { name: 'fine_tool', description: 'ok', parameters: { type: 'object', properties: {} } } },
        async execute() { return { content: 'ok', isError: false } },
      }] }`,
    })
    const result = await new PluginsModule({ trustProjectCode: true }).boot(bootCtx())
    expect((result.tools ?? []).map((t) => t.name)).toEqual(['fine_tool'])
  })

  it('rejects exports that do not satisfy the Tool shape', async () => {
    makePlugin('badshape', { provides: { tools: ['tools.js'] } }, {
      'tools.js': `module.exports = { tools: [{ name: 42, definition: null }] }`,
    })
    const result = await new PluginsModule({ trustProjectCode: true }).boot(bootCtx())
    expect(result.tools ?? []).toHaveLength(0)
  })
})
