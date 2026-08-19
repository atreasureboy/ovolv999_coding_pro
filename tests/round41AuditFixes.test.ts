import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Round 41 — regression tests for the full-audit fixes. Each test pins a
 * bug confirmed by the three audit passes (logic, protocol, integration).
 */

let cwd = ''

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'ovogo-round41-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

// ── jsonc: trailing-comma stripping must be string-aware ──────────────────

describe('jsonc string-aware comma handling', () => {
  it('preserves ", }" and ",]" sequences inside string values', async () => {
    const { stripJsonc, parseJsonc } = await import('../src/utils/jsonc.js')
    const doc = `{
      // sed payload with a trailing-comma pattern inside a string
      "allowedCommands": "sed -e 's/, }//g' file.txt",
      "matrix": [1, [2, "x,]y"]],
    }`
    const parsed = parseJsonc<{ allowedCommands: string; matrix: unknown[] }>(doc)
    expect(parsed.allowedCommands).toBe("sed -e 's/, }//g' file.txt")
    expect(parsed.matrix).toEqual([1, [2, 'x,]y']])
    // Plain (non-JSONC) JSON must pass through byte-identical.
    expect(stripJsonc('{"a":"b, }c"}')).toBe('{"a":"b, }c"}')
  })
})

// ── fork: dangling tool_calls produce a LIVE fork ─────────────────────────

describe('fork dangling tool_calls trim', () => {
  it('drops the dangling group instead of shipping a dead session', async () => {
    const { computeForkCutPoint, forkSession, createSessionDir, saveSession, loadSessionEnvelope } =
      await import('../src/core/sessionManager.js')
    // Aborted turn: assistant asked for two tools, only one answered.
    const history = [
      { role: 'user' as const, content: 'go' },
      { role: 'assistant' as const, content: null, tool_calls: [
        { id: 't1', type: 'function' as const, function: { name: 'Bash', arguments: '{}' } },
        { id: 't2', type: 'function' as const, function: { name: 'Bash', arguments: '{}' } },
      ] },
      { role: 'tool' as const, tool_call_id: 't1', content: 'ok' },
      { role: 'user' as const, content: 'next' },
    ]
    const cut = computeForkCutPoint(history)
    expect(cut).toBeLessThan(history.length)
    // Prefix must be fully consistent: no unanswered ids, no orphans.
    const prefix = history.slice(0, cut)
    const issued = new Set<string>()
    for (const m of prefix) {
      if (m.role === 'assistant' && m.tool_calls) {
        for (const tc of m.tool_calls) issued.add(tc.id)
      }
      if (m.role === 'tool') issued.delete(m.tool_call_id)
    }
    expect(issued.size).toBe(0)

    const dir = createSessionDir(cwd)
    saveSession(dir, history)
    const fork = forkSession(cwd, dir)
    const env = loadSessionEnvelope(fork.forkDir)
    expect(env?.messages.length).toBe(cut)
  })
})

// ── saveSession: title survives outcome-less saves ────────────────────────

describe('saveSession title preservation', () => {
  it('keeps a previously-set title across a 2-arg save (the /title wipe bug)', async () => {
    const { createSessionDir, saveSession, setSessionTitle, loadSessionEnvelope } =
      await import('../src/core/sessionManager.js')
    const dir = createSessionDir(cwd)
    const history = [{ role: 'user' as const, content: 'hi' }]
    saveSession(dir, history)
    setSessionTitle(dir, 'Kept title')
    // The regular REPL save path: 3 args, no title.
    saveSession(dir, [...history, { role: 'assistant' as const, content: 'ok' }])
    expect(loadSessionEnvelope(dir)?.title).toBe('Kept title')
  })
})

// ── applyPatch: CRLF + literal @@ context lines ───────────────────────────

describe('applyPatch parser hardening', () => {
  it('accepts CRLF patch documents', async () => {
    const { ApplyPatchTool } = await import('../src/tools/applyPatch.js')
    const file = join(cwd, 'f.txt')
    writeFileSync(file, 'a\nb\n')
    const patch = [
      '*** Begin Patch',
      '*** Update File: f.txt',
      '@@',
      '-a',
      '+A',
      '*** End Patch',
    ].join('\r\n') + '\r\n'
    const result = await new ApplyPatchTool().execute({ patch }, { cwd, permissionMode: 'auto' })
    expect(result.isError).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('A\nb\n')
  })

  it('keeps a context line that literally starts with @@', async () => {
    const { ApplyPatchTool } = await import('../src/tools/applyPatch.js')
    const file = join(cwd, 'fixture.diff')
    writeFileSync(file, 'header\n@@literal marker\ntail\n')
    // Unprefixed context lines — including one that STARTS with '@@'.
    const patch = [
      '*** Begin Patch',
      '*** Update File: fixture.diff',
      '@@',
      'header',
      '@@literal marker',
      '-tail',
      '+TAIL',
      '*** End Patch',
    ].join('\n')
    const result = await new ApplyPatchTool().execute({ patch }, { cwd, permissionMode: 'auto' })
    expect(result.isError).toBe(false)
    const out = readFileSync(file, 'utf8')
    expect(out).toContain('@@literal marker')
    expect(out).toContain('TAIL')
  })

  it('registers created files for rewind cleanup (markCreated)', async () => {
    const { ApplyPatchTool } = await import('../src/tools/applyPatch.js')
    const { FileHistory } = await import('../src/core/fileHistory.js')
    const sessionDir = join(cwd, 'sess')
    const fh = new FileHistory(sessionDir)
    const patch = '*** Begin Patch\n*** Add File: born.txt\n+hi\n*** End Patch'
    await new ApplyPatchTool().execute({ patch }, { cwd, permissionMode: 'auto', fileHistory: fh, sessionDir })
    expect(fh.getCreatedFiles()).toContain(join(cwd, 'born.txt'))
  })
})

// ── events: emit must iterate a copy ──────────────────────────────────────

describe('RunEventEmitter copy-on-emit', () => {
  it('a handler unsubscribing another handler does not skip it', async () => {
    const { RunEventEmitter } = await import('../src/core/runtime/events.js')
    const e = new RunEventEmitter()
    const calls: string[] = []
    const offB = (): void => e.off('MODEL_CHANGED', handlerB)
    const handlerA = (): void => {
      calls.push('a')
      offB()
    }
    const handlerB = (): void => {
      calls.push('b')
    }
    e.on('MODEL_CHANGED', handlerA)
    e.on('MODEL_CHANGED', handlerB)
    e.emit({ type: 'MODEL_CHANGED', from: 'x', to: 'y' })
    expect(calls).toEqual(['a', 'b']) // b ran despite a unsubscribing it mid-emit
  })
})

// ── engine: PROVIDER_CHANGED fires on cross-provider rebind ────────────────

describe('PROVIDER_CHANGED event', () => {
  it('is emitted when rebindTransport commits', async () => {
    const { ExecutionEngine } = await import('../src/core/engine.js')
    const renderer: Record<string, () => void> = {}
    for (const k of ['banner', 'raw', 'info', 'warn', 'error', 'success', 'startSpinner', 'stopSpinner']) renderer[k] = () => {}
    const CAPS = { reasoning: 0.8, coding: 0.8, contextWindow: 128_000, toolCalling: 0.8, speed: 0.7, cost: 0.5 }
    // Key must exist BEFORE construction: availability gating runs in buildRouter.
    process.env.R41_KEY = 'sk-r41'
    const engine = new ExecutionEngine({
      model: 'gpt-x', apiKey: 'k', maxIterations: 5, cwd, permissionMode: 'auto',
      enabledModules: [], provider: 'openai',
      models: { profiles: [
        { id: 'main', provider: 'openai', model: 'gpt-x', tier: 'top', capabilities: CAPS, roles: ['main'], available: true },
        { id: 'deep', provider: 'deepseek', model: 'd-chat', tier: 'top', capabilities: CAPS, roles: ['main'], available: true, apiKeyEnv: 'R41_KEY', baseURL: 'https://api.deepseek.com/v1' },
      ], routing: { enabled: false } },
    }, renderer as never, { chat: { completions: { create: async () => ({ choices: [] }) } } } as never)
    const seen: string[] = []
    const emitter = engine.getEventEmitter()
    emitter.on('PROVIDER_CHANGED', (evt) => seen.push(`${evt.from}->${evt.to}`))
    engine.setModelByUser('deep')
    expect(seen).toEqual(['openai->deepseek'])
    delete process.env.R41_KEY
  })
})

// ── engine: unavailable cross-provider profiles are not routable ───────────

describe('cross-provider availability gating', () => {
  it('profiles without an API key in env stay unroutable (available=false)', async () => {
    const { ExecutionEngine } = await import('../src/core/engine.js')
    const renderer: Record<string, () => void> = {}
    for (const k of ['banner', 'raw', 'info', 'warn', 'error', 'success', 'startSpinner', 'stopSpinner']) renderer[k] = () => {}
    const CAPS = { reasoning: 0.8, coding: 0.8, contextWindow: 128_000, toolCalling: 0.8, speed: 0.7, cost: 0.5 }
    delete process.env.R41_MISSING_KEY
    const engine = new ExecutionEngine({
      model: 'gpt-x', apiKey: 'k', maxIterations: 5, cwd, permissionMode: 'auto',
      enabledModules: [], provider: 'openai',
      models: { profiles: [
        { id: 'main', provider: 'openai', model: 'gpt-x', tier: 'top', capabilities: CAPS, roles: ['main'], available: true },
        { id: 'locked', provider: 'anthropic', model: 'cl-x', tier: 'top', capabilities: CAPS, roles: ['main'], available: true, apiKeyEnv: 'R41_MISSING_KEY' },
      ], routing: { enabled: false } },
    }, renderer as never, { chat: { completions: { create: async () => ({ choices: [] }) } } } as never)
    // Stays in the router (manual /model gets the actionable rebind error)
    // but is flagged unavailable so route()/fallback chains skip it.
    const locked = engine.getModelRouter().listProfiles().find((p) => p.id === 'locked')
    expect(locked?.available).toBe(false)
    // And a manual switch REFUSES with the missing-key message (no silent
    // wrong-endpoint switch).
    expect(() => engine.setModelByUser('locked')).toThrow(/API key/)
  })
})

// ── agentToolFilter: case-insensitive allowlist ────────────────────────────

describe('agent tool allowlist casing', () => {
  it('lowercase frontmatter tool names still match', async () => {
    const { filterToolsForSubAgent } = await import('../src/core/agentToolFilter.js')
    const result = filterToolsForSubAgent(['Read', 'Bash', 'Edit'], ['read', 'bash'], undefined)
    expect(result).toEqual(['Read', 'Bash'])
  })
})

// ── httpServer: fatal bind errors are not retried as port walks ───────────

describe('ObservabilityServer bind errors', () => {
  it('surfaces fatal bind errors with the real code', async () => {
    const { ObservabilityServer } = await import('../src/server/httpServer.js')
    const srv = new ObservabilityServer({ cwd, port: 7717, host: 'not-a-valid-host-!' })
    await expect(srv.start()).rejects.toThrow(/cannot bind/)
  })
})
