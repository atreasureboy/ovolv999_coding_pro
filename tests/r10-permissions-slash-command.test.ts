/**
 * R10.3: prove that the /permissions slash command reaches the
 * real PermissionManager and that sub-commands actually mutate state.
 */

import { describe, it, expect } from 'vitest'
import { PermissionManager } from '../src/core/permissionSystem.js'
import type { PermissionMode, PermissionRule } from '../src/core/permissionSystem.js'
import { getCommand } from '../src/commands/index.js'
import type { SlashCommandContext } from '../src/commands/index.js'
import type { OpenAIMessage } from '../src/core/types.js'
import '../src/commands/builtin.js' // side-effect: register /permissions

class MockEngine {
  private pm = new PermissionManager()
  getPermissionManager(): PermissionManager { return this.pm }
}

function makeCtx(persistPath: { written?: string } = {}): SlashCommandContext {
  const noopRenderer = {
    raw: () => {}, info: () => {}, warn: () => {}, error: () => {},
    userMessage: () => {}, assistantMessage: () => {}, toolCall: () => {},
    toolResult: () => {}, cost: () => {}, compactionNotice: () => {},
    turnEnd: () => {}, planModeHeader: () => {},
  } as never
  return {
    engine: new MockEngine() as never,
    renderer: noopRenderer,
    history: [] as OpenAIMessage[],
    cwd: '/tmp',
    setHistory: () => {},
    runPrompt: () => {},
    persistPermissions: (mode: PermissionMode, rules: PermissionRule[]) => {
      persistPath.written = `mode=${mode}, rules=${rules.length}`
      return persistPath.written
    },
  }
}

function extractText(result: unknown): string {
  if (typeof result === 'string') return result
  if (result && typeof result === 'object') {
    const r = result as { type?: string; value?: string }
    if (r.type === 'text' && typeof r.value === 'string') return r.value
  }
  return String(result)
}

function getPM(ctx: SlashCommandContext): PermissionManager {
  return (ctx.engine as unknown as MockEngine).getPermissionManager()
}

describe('R10.3: /permissions slash command', () => {
  it('exists and lists mode + rules', () => {
    const cmd = getCommand('permissions')
    expect(cmd).toBeDefined()
    const ctx = makeCtx()
    const out = extractText(cmd!.handler('rules', ctx))
    expect(out).toContain('No permission rules')
  })

  it('allow — adds an allow rule', () => {
    const ctx = makeCtx()
    const cmd = getCommand('permissions')!
    const out = extractText(cmd.handler('allow Bash "npm *"', ctx))
    expect(out).toMatch(/Added permission rule/)
    const pm = getPM(ctx)
    expect(pm.getRules().length).toBe(1)
    expect(pm.getRules()[0]?.behavior).toBe('allow')
  })

  it('deny — adds a deny rule', () => {
    const ctx = makeCtx()
    const cmd = getCommand('permissions')!
    const out = extractText(cmd.handler('deny Read "*.secret"', ctx))
    expect(out).toMatch(/Added permission rule/)
    const pm = getPM(ctx)
    expect(pm.getRules()[0]?.behavior).toBe('deny')
  })

  it('remove — removes by index', () => {
    const ctx = makeCtx()
    const cmd = getCommand('permissions')!
    cmd.handler('allow Bash "ls"', ctx)
    cmd.handler('allow Bash "grep"', ctx)
    expect(getPM(ctx).getRules().length).toBe(2)
    const out = extractText(cmd.handler('remove 0', ctx))
    expect(out).toMatch(/Removed/)
    expect(getPM(ctx).getRules().length).toBe(1)
  })

  it('remove — out-of-range index is a clean error', () => {
    const ctx = makeCtx()
    const cmd = getCommand('permissions')!
    const out = extractText(cmd.handler('remove 99', ctx))
    expect(out).toMatch(/Usage: \/permissions remove/)
  })

  it('clear — removes all rules', () => {
    const ctx = makeCtx()
    const cmd = getCommand('permissions')!
    cmd.handler('allow Bash "a"', ctx)
    cmd.handler('allow Bash "b"', ctx)
    cmd.handler('deny Read "c"', ctx)
    expect(getPM(ctx).getRules().length).toBe(3)
    const out = extractText(cmd.handler('clear', ctx))
    expect(out).toMatch(/Cleared 3/)
    expect(getPM(ctx).getRules().length).toBe(0)
  })

  it('mode — changes mode', () => {
    const ctx = makeCtx()
    const cmd = getCommand('permissions')!
    const out = extractText(cmd.handler('mode auto', ctx))
    expect(out).toContain('auto')
    expect(getPM(ctx).getMode()).toBe('auto')
  })

  it('mode — rejects invalid mode', () => {
    const ctx = makeCtx()
    const cmd = getCommand('permissions')!
    const out = extractText(cmd.handler('mode funky', ctx))
    expect(out).toMatch(/Unknown permission mode/)
  })

  it('mode — R12: accepts dontAsk (the 6th mode from the 7-mode union)', () => {
    const ctx = makeCtx()
    const cmd = getCommand('permissions')!
    const out = extractText(cmd.handler('mode dontAsk', ctx))
    expect(out).toContain('dontAsk')
    expect(getPM(ctx).getMode()).toBe('dontAsk')
  })

  it('mode — R12: accepts bubble (the 7th mode from the 7-mode union)', () => {
    const ctx = makeCtx()
    const cmd = getCommand('permissions')!
    const out = extractText(cmd.handler('mode bubble', ctx))
    expect(out).toContain('bubble')
    expect(getPM(ctx).getMode()).toBe('bubble')
  })

  it('cycle — advances to next mode', () => {
    const ctx = makeCtx()
    const cmd = getCommand('permissions')!
    const before = getPM(ctx).getMode()
    const out = extractText(cmd.handler('cycle', ctx))
    expect(out).toMatch(/Switched to/)
    expect(getPM(ctx).getMode()).not.toBe(before)
  })

  it('persists after every mutation', () => {
    const path = { written: undefined as string | undefined }
    const ctx = makeCtx(path)
    const cmd = getCommand('permissions')!
    cmd.handler('allow Bash "foo"', ctx)
    expect(path.written).toMatch(/mode=default, rules=1/)
    cmd.handler('clear', ctx)
    expect(path.written).toMatch(/mode=default, rules=0/)
    cmd.handler('mode auto', ctx)
    expect(path.written).toMatch(/mode=auto, rules=0/)
  })

  it('persists an in-memory rule survives across the same engine instance', () => {
    // Sanity: the engine's pm.addRule really mutates the manager
    const ctx = makeCtx()
    const cmd = getCommand('permissions')!
    cmd.handler('allow Bash "x"', ctx)
    cmd.handler('allow Bash "y"', ctx)
    cmd.handler('allow Bash "z"', ctx)
    expect(getPM(ctx).getRules().length).toBe(3)
  })
})
