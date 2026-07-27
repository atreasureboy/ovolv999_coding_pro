import { describe, expect, it } from 'vitest'
import { dispatchSlashCommand, normalizeSlashCommandInput, registerCommand } from '../src/commands/index.js'

describe('slash command normalization', () => {
  it('normalizes full-width slash punctuation without changing arguments', () => {
    expect(normalizeSlashCommandInput('/？')).toBe('/?')
    expect(normalizeSlashCommandInput('／loop 修复当前项目')).toBe('/loop 修复当前项目')
  })

  it('dispatches the Chinese full-width help alias as a command', async () => {
    registerCommand({
      name: 'normalization-test-help',
      aliases: ['?'],
      description: 'test',
      handler: () => ({ type: 'text', value: 'all commands' }),
    })
    const result = await dispatchSlashCommand('/？', {
      engine: {} as never,
      renderer: {} as never,
      history: [],
      cwd: '/',
      setHistory: () => {},
      runPrompt: () => {},
    })

    expect(result).toEqual({ type: 'text', value: 'all commands' })
  })
})
