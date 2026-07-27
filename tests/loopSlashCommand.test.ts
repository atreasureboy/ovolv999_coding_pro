import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SlashCommandContext } from '../src/commands/index.js'
import { dispatchSlashCommand } from '../src/commands/index.js'
import '../src/commands/builtin.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function context(cwd: string, runLoop: SlashCommandContext['runLoop']): SlashCommandContext {
  return {
    engine: {} as never,
    renderer: {} as never,
    history: [],
    cwd,
    setHistory: () => {},
    runPrompt: () => {},
    runLoop,
  }
}

describe('/loop command', () => {
  it('creates a goal and starts the autonomous loop directly', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ovolv-loop-slash-'))
    roots.push(cwd)
    const runLoop = vi.fn(async () => {})

    const result = await dispatchSlashCommand('/loop audit and repair the project', context(cwd, runLoop))

    expect(result).toEqual({ type: 'noop' })
    expect(runLoop).toHaveBeenCalledWith({ restart: true })
    expect(readFileSync(join(cwd, '.loop', 'GOAL.md'), 'utf8')).toContain('audit and repair the project')
  })

  it('continues an existing loop without replacing its goal', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ovolv-loop-continue-'))
    roots.push(cwd)
    const firstRun = vi.fn(async () => {})
    await dispatchSlashCommand('/loop first goal', context(cwd, firstRun))
    const runLoop = vi.fn(async () => {})

    await dispatchSlashCommand('/loop continue', context(cwd, runLoop))

    expect(runLoop).toHaveBeenCalledWith({})
    expect(readFileSync(join(cwd, '.loop', 'GOAL.md'), 'utf8')).toContain('first goal')
  })
})
