import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadCustomAgents, customAgentNames, getCustomAgent, customAgentToConfig } from '../src/core/customAgents.js'
import { resolveAgentConfig } from '../src/core/agentPresets.js'

let cwd = ''

function writeAgent(name: string, content: string): void {
  mkdirSync(join(cwd, '.agents'), { recursive: true })
  writeFileSync(join(cwd, '.agents', name), content, 'utf8')
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'ovogo-custom-agents-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

describe('loadCustomAgents', () => {
  it('parses a markdown agent with frontmatter', () => {
    writeAgent('sql-reviewer.md', [
      '---',
      'name: sql-reviewer',
      'description: Reviews SQL migrations',
      'tools: Read, Grep , Bash',
      'maxIterations: 25',
      'planMode: true',
      '---',
      'You are a SQL migration reviewer.',
      'Be strict about backwards compatibility.',
    ].join('\n'))

    const defs = loadCustomAgents(cwd)
    expect(defs).toHaveLength(1)
    const def = defs[0]
    expect(def.name).toBe('sql-reviewer')
    expect(def.description).toBe('Reviews SQL migrations')
    expect(def.tools).toEqual(['Read', 'Grep', 'Bash'])
    expect(def.maxIterations).toBe(25)
    expect(def.planMode).toBe(true)
    expect(def.prompt).toContain('You are a SQL migration reviewer.')
  })

  it('uses the file basename when name is absent', () => {
    writeAgent('deploy.md', '---\ndescription: d\n---\nDo deploys.')
    const def = getCustomAgent(cwd, 'deploy')
    expect(def).not.toBeNull()
    expect(def!.prompt).toBe('Do deploys.')
  })

  it('parses JSON agents', () => {
    writeAgent('helper.json', JSON.stringify({
      name: 'helper',
      prompt: 'You help with X.',
      tools: ['Read'],
      maxIterations: 10,
    }))
    const def = getCustomAgent(cwd, 'helper')
    expect(def).not.toBeNull()
    expect(def!.tools).toEqual(['Read'])
  })

  it('skips invalid definitions instead of surfacing them', () => {
    writeAgent('empty.md', '---\nname: empty\n---\n')
    writeAgent('bad.json', '{ not json')
    writeAgent('good.md', '---\nname: good\n---\nDo things.')
    expect(customAgentNames(cwd)).toEqual(['good'])
  })

  it('project agents win over same-named files in other roots', () => {
    writeAgent('a.md', 'Prompt A')
    writeAgent('b.md', 'Prompt B')
    const names = customAgentNames(cwd).sort()
    expect(names).toEqual(['a', 'b'])
  })

  it('caps oversized agent files', () => {
    writeAgent('huge.md', 'x'.repeat(600 * 1024))
    expect(loadCustomAgents(cwd)).toHaveLength(0)
  })
})

describe('resolveAgentConfig integration', () => {
  it('resolves a custom agent by preset name when cwd is supplied', () => {
    writeAgent('my-agent.md', 'You are my custom agent.')
    const config = resolveAgentConfig({ preset: 'my-agent' }, cwd)
    expect(config.identity.systemPrompt(cwd)).toContain('You are my custom agent.')
    expect(config.identity.systemPrompt(cwd)).toContain(cwd)
  })

  it('built-in presets win over same-named custom agents', () => {
    writeAgent('explore.md', 'I should never be used.')
    const config = resolveAgentConfig({ preset: 'explore' }, cwd)
    expect(config.identity.systemPrompt(cwd)).toContain('Explore sub-agent')
  })

  it('unknown presets throw with custom names listed', () => {
    writeAgent('real-agent.md', 'Real prompt.')
    expect(() => resolveAgentConfig({ preset: 'typo-agent' }, cwd))
      .toThrow(/real-agent/)
  })

  it('customAgentToConfig carries tools and limits', () => {
    writeAgent('tooled.json', JSON.stringify({
      name: 'tooled', prompt: 'P.', tools: ['Read', 'Glob'], maxIterations: 12,
    }))
    const def = getCustomAgent(cwd, 'tooled')!
    const config = customAgentToConfig(def)
    expect(config.tools).toEqual(['Read', 'Glob'])
    expect(config.maxIterations).toBe(12)
  })
})
