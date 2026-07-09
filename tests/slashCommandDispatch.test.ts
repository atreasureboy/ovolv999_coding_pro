import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearRegistry,
  dispatchSlashCommand,
  registerCommand,
  type SlashCommandContext,
} from '../src/commands/index.js'

function ctx(resolveSkillPrompt?: (name: string, args: string) => string | null): SlashCommandContext {
  return {
    resolveSkillPrompt,
  } as unknown as SlashCommandContext
}

describe('dispatchSlashCommand', () => {
  beforeEach(() => {
    clearRegistry()
  })

  it('returns null for non-slash input', async () => {
    await expect(dispatchSlashCommand('hello', ctx())).resolves.toBeNull()
  })

  it('dispatches registered commands', async () => {
    registerCommand({
      name: 'ping',
      description: 'test command',
      handler: () => ({ type: 'text', value: 'pong' }),
    })

    await expect(dispatchSlashCommand('/ping', ctx())).resolves.toEqual({ type: 'text', value: 'pong' })
  })

  it('resolves dynamic skill prompts when no command matches', async () => {
    const result = await dispatchSlashCommand('/review src/core', ctx((name, args) => {
      if (name === 'review') return 'Review task: ' + args
      return null
    }))

    expect(result).toEqual({ type: 'prompt', value: 'Review task: src/core' })
  })

  it('prefers registered commands over same-name skills', async () => {
    registerCommand({
      name: 'review',
      description: 'built-in review command',
      handler: () => ({ type: 'text', value: 'command review' }),
    })

    const result = await dispatchSlashCommand('/review src/core', ctx(() => 'skill review'))

    expect(result).toEqual({ type: 'text', value: 'command review' })
  })

  it('returns null when neither command nor skill exists', async () => {
    await expect(dispatchSlashCommand('/missing', ctx(() => null))).resolves.toBeNull()
  })
})
