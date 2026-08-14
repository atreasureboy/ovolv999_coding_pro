/**
 * Round 26 regression tests — hooks unification + shell-session auth.
 *
 * 1. Hook consolidation: legacy (flat, PreToolCall-aliased) and canonical
 *    (CC-schema PreToolUse) settings entries both normalize to ONE schema
 *    and fire through ONE runner (DefaultHookRunner) — including the
 *    runPreToolUse permission-decision path the old main-path runner
 *    silently dropped.
 * 2. ShellSession auth handshake: a connecting client must present the
 *    per-session token before traffic is accepted (L2).
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as net from 'node:net'
import { normalizeHooksSection, LEGACY_HOOK_EVENT_ALIASES, matcherMatches } from '../src/core/hooks/hooksConfig.js'
import { DefaultHookRunner } from '../src/core/hooks/defaultRunner.js'
import { executeHookCommand } from '../src/core/hooks/hookExecutor.js'
import { loadProjectSettings } from '../src/config/settings.js'
import { ShellSessionTool } from '../src/tools/shellSession.js'
import type { ToolContext } from '../src/core/types.js'

describe('Hook consolidation (Round 26)', () => {
  let workDir: string

  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true })
  })

  it('legacy flat entries + event aliases normalize to the CC schema', () => {
    const cfg = normalizeHooksSection({
      PreToolCall: [{ matcher: 'Bash', command: 'echo pre' }],
      OnComplete: [{ command: 'echo done' }],
      OnContextOverflow: [{ command: 'echo compact' }],
    })
    expect(cfg?.PreToolUse).toHaveLength(1)
    expect(cfg?.PreToolUse?.[0]?.matcher).toBe('Bash')
    expect(cfg?.PreToolUse?.[0]?.hooks?.[0]?.command).toBe('echo pre')
    // OnComplete → Stop, OnContextOverflow → PreCompact
    expect(cfg?.Stop).toHaveLength(1)
    expect(cfg?.PreCompact).toHaveLength(1)
  })

  it('CC-schema entries in settings.json survive loadProjectSettings (no silent drop)', () => {
    workDir = mkdtempSync(join(tmpdir(), 'r26-hooks-'))
    mkdirSync(join(workDir, '.ovogo'), { recursive: true })
    writeFileSync(
      join(workDir, '.ovogo', 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: 'echo cc-hook' }],
            },
          ],
        },
      }),
    )
    const settings = loadProjectSettings(workDir)
    expect(settings.hooks?.PreToolUse).toHaveLength(1)
    expect(settings.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command).toBe('echo cc-hook')
  })

  it('DefaultHookRunner implements the Phase-2 engine surface (runPreToolUse) — the capability the old main-path runner dropped', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'r26-hooks-'))
    const runner = new DefaultHookRunner({
      cwd: workDir,
      configOverride: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'printf \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"blocked by test"}}\'' }],
          },
        ],
      },
    })
    expect(typeof runner.runPreToolUse).toBe('function')
    const outcomes = await runner.runPreToolUse('Bash', { command: 'x' }, new AbortController().signal)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0].decision).toBe('deny')
    expect(outcomes[0].reason).toBe('blocked by test')
  })

  it('alias map covers the legacy engine event names', () => {
    expect(LEGACY_HOOK_EVENT_ALIASES.PreToolCall).toBe('PreToolUse')
    expect(LEGACY_HOOK_EVENT_ALIASES.PostToolCall).toBe('PostToolUse')
    expect(LEGACY_HOOK_EVENT_ALIASES.OnComplete).toBe('Stop')
    expect(LEGACY_HOOK_EVENT_ALIASES.OnContextOverflow).toBe('PreCompact')
  })

  it('re-audit D2: legacy matcher syntax keeps matching — comma lists, pipe lists, trailing *', () => {
    expect(matcherMatches('Write,Edit', 'Edit')).toBe(true)
    expect(matcherMatches('Write,Edit', 'Bash')).toBe(false)
    expect(matcherMatches('Bash|Edit', 'Bash')).toBe(true)
    expect(matcherMatches('Bash*', 'BashOutput')).toBe(true)
    expect(matcherMatches('Bash*', 'Edit')).toBe(false)
    expect(matcherMatches('/^Web/', 'WebFetch')).toBe(true)
    expect(matcherMatches(undefined, 'anything')).toBe(true)
    expect(matcherMatches('*', 'anything')).toBe(true)
  })

  it('re-audit D4: unknown/typo events and __proto__ are rejected with diagnostics, OnError reports its migration path', () => {
    const issues: Array<[string, string]> = []
    // JSON.parse simulates real settings input — a literal {__proto__: …}
    // would set the prototype instead of creating an own key.
    const raw = JSON.parse('{"PreToolUs":[{"command":"echo typo"}],"OnError":[{"command":"echo err"}],"__proto__":[{"command":"echo evil"}]}') as Record<string, unknown>
    const cfg = normalizeHooksSection(
      raw,
      (field, message) => issues.push([field, message]),
    )
    expect(cfg).toBeNull()
    expect(issues).toHaveLength(3)
    expect(issues[0][0]).toBe('hooks.PreToolUs')
    expect(issues[1][1]).toContain('OnError')
    expect(issues[1][1]).toContain('PostToolUse')
    expect(issues[2][0]).toBe('hooks.__proto__')
  })

  it('re-audit D3: legacy OVOGO_* env contract is preserved on hook execution', async () => {
    const result = await executeHookCommand(
      { type: 'command', command: 'printf "name=%s event=%s" "$OVOGO_TOOL_NAME" "$OVOGO_HOOK_EVENT"' },
      { session_id: 'sess-1', cwd: '/tmp', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } } as never,
      { cwd: '/tmp', timeoutMs: 5000 },
    )
    expect(result.ok).toBe(true)
    expect(result.output).toBeNull() // printf output is not JSON → no parsed output
    expect(result.rawStdoutPreview).toContain('name=Bash')
    expect(result.rawStdoutPreview).toContain('event=PreToolUse')
  })

  it('re-audit D1: a hook that exits without reading stdin does not crash (EPIPE swallowed)', async () => {
    const result = await executeHookCommand(
      { type: 'command', command: 'true' },
      { session_id: 'sess-2', cwd: '/tmp', hook_event_name: 'Stop', reason: 'test' } as never,
      { cwd: '/tmp', timeoutMs: 5000 },
    )
    expect(result.ok).toBe(true)
    // The EPIPE on the stdin write is async — give it a beat to prove no
    // unhandled 'error' escapes (an escaping one fails the whole suite).
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
})

describe('ShellSession auth handshake (Round 26 L2)', () => {
  const tool = new ShellSessionTool()
  const ctx: ToolContext = { cwd: process.cwd(), permissionMode: 'auto' }
  const PORT = 45499

  afterEach(async () => {
    await tool.execute({ action: 'kill', port: PORT }, ctx)
  })

  it('rejects a client without the token, accepts one with it', async () => {
    const logDir = mkdtempSync(join(tmpdir(), 'r26-shell-'))
    const listen = await tool.execute({ action: 'listen', port: PORT, log_dir: logDir }, ctx)
    expect(listen.isError).toBe(false)
    const token = /Auth token: ([0-9a-f]+)/.exec(listen.content)?.[1]
    expect(token).toBeTruthy()

    // Wrong token → connection dropped, session stays unconnected
    const bad = await new Promise<boolean>((resolve) => {
      const sock = net.connect(PORT, '127.0.0.1', () => {
        sock.write(`auth wrong-token\n`)
      })
      sock.once('close', () => resolve(true))
      sock.once('error', () => resolve(true))
      setTimeout(() => resolve(false), 3000)
    })
    expect(bad).toBe(true)

    const status1 = await tool.execute({ action: 'list' }, ctx)
    expect(status1.content).toMatch(/LISTENING/)

    // Correct token → connected
    await new Promise<void>((resolve, reject) => {
      const sock = net.connect(PORT, '127.0.0.1', () => {
        sock.write(`auth ${token}\nid\n`)
        setTimeout(() => { sock.end(); resolve() }, 300)
      })
      sock.once('error', reject)
    })

    const status2 = await tool.execute({ action: 'list' }, ctx)
    expect(status2.content).toMatch(/CONNECTED/)
    rmSync(logDir, { recursive: true, force: true })
  }, 15_000)
})
