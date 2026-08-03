/**
 * v0.5.2 (C2 — borrowed from codex execpolicy DSL):
 * tests for host_executable + strictestWins aggregation.
 */
import { describe, it, expect } from 'vitest'
import {
  strictestWins,
  evaluateHostExecutable,
  evaluateBashPolicy,
  DEFAULT_PERMISSION_CONFIG,
} from '../src/core/permissionRules.js'

describe('execpolicy DSL extension (C2)', () => {
  it('strictestWins: deny > ask > allow', () => {
    expect(strictestWins({ defaultDecision: 'allow' })).toBe('allow')
    expect(strictestWins({ defaultDecision: 'allow', modeDecision: 'ask' })).toBe('ask')
    expect(strictestWins({ defaultDecision: 'allow', modeDecision: 'ask', globDecision: 'deny' })).toBe('deny')
    expect(strictestWins({ defaultDecision: 'deny' })).toBe('deny')
  })

  it('strictestWins: hostExecutable can override glob allow', () => {
    expect(strictestWins({
      defaultDecision: 'allow',
      globDecision: 'allow',
      hostExecutableDecision: 'deny',
    })).toBe('deny')
  })

  it('evaluateHostExecutable matches the first binary token', () => {
    const cfg = DEFAULT_PERMISSION_CONFIG
    expect(evaluateHostExecutable('rm -rf /tmp/x', cfg)?.decision).toBe('deny')
    expect(evaluateHostExecutable('sudo apt update', cfg)?.decision).toBe('deny')
    expect(evaluateHostExecutable('ls -la', cfg)).toBeUndefined()
    expect(evaluateHostExecutable('curl https://example.com', cfg)?.decision).toBe('ask')
  })

  it('evaluateHostExecutable handles path-prefixed binaries', () => {
    const cfg = DEFAULT_PERMISSION_CONFIG
    expect(evaluateHostExecutable('/usr/bin/rm -rf /tmp/x', cfg)?.decision).toBe('deny')
  })

  it('evaluateBashPolicy combines glob + host_executable + default', () => {
    const cfg = DEFAULT_PERMISSION_CONFIG
    // rm is denied by host_executable even though the default is allow
    const r = evaluateBashPolicy({ command: 'rm -rf /tmp' }, cfg)
    expect(r.decision).toBe('deny')
    expect(r.reason).toMatch(/host_executable/)
  })

  it('evaluateBashPolicy falls through to default when no rules match', () => {
    const cfg = { ...DEFAULT_PERMISSION_CONFIG, defaultDecision: 'ask' as const }
    const r = evaluateBashPolicy({ command: 'ls -la' }, cfg)
    expect(r.decision).toBe('ask')
  })
})