import { describe, it, expect } from 'vitest'
import { runCommand, runCommandSync } from '../src/core/commandRunner.js'

describe('CommandRunner (Phase 2)', () => {
  it('returns exitCode 0 + captured stdout for a successful command', async () => {
    const r = await runCommand({ executable: 'node', args: ['-e', 'process.stdout.write("hi")'], cwd: process.cwd() })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('hi')
    expect(r.timedOut).toBe(false)
    expect(r.cancelled).toBe(false)
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('returns the non-zero exitCode (never throws) and stderr for failure', async () => {
    const r = await runCommand({
      executable: 'node', args: ['-e', 'process.stderr.write("boom"); process.exit(3)'], cwd: process.cwd(),
    })
    expect(r.exitCode).toBe(3)
    expect(r.stderr).toContain('boom')
    expect(r.timedOut).toBe(false)
  })

  it('kills the process tree and flags timedOut on timeout', async () => {
    const r = await runCommand({
      executable: 'node', args: ['-e', 'setInterval(()=>0, 1000)'], cwd: process.cwd(), timeoutMs: 500,
    })
    expect(r.timedOut).toBe(true)
    // Killed by signal → exitCode null
    expect(r.exitCode).toBeNull()
  })

  it('aborts via AbortSignal and flags cancelled', async () => {
    const ac = new AbortController()
    const p = runCommand({
      executable: 'node', args: ['-e', 'setInterval(()=>0, 1000)'], cwd: process.cwd(), signal: ac.signal,
    })
    setTimeout(() => ac.abort(), 200)
    const r = await p
    expect(r.cancelled).toBe(true)
  })

  it('truncates output beyond outputLimitBytes and sets truncated=true', async () => {
    const r = await runCommand({
      executable: 'node',
      args: ['-e', 'process.stdout.write("x".repeat(10000))'],
      cwd: process.cwd(),
      outputLimitBytes: 1000,
    })
    expect(r.stdout.length).toBeLessThanOrEqual(1000)
    expect(r.truncated).toBe(true)
  })

  it('shell:true runs a trusted string command', async () => {
    const r = await runCommand({
      executable: 'node -e "process.stdout.write(\'shell-ok\')"',
      args: [],
      cwd: process.cwd(),
      shell: true,
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('shell-ok')
  })

  it('runCommandSync mirrors the contract synchronously', () => {
    const ok = runCommandSync({ executable: 'node', args: ['-e', 'process.stdout.write("s")'], cwd: process.cwd() })
    expect(ok.exitCode).toBe(0)
    expect(ok.stdout).toBe('s')

    const fail = runCommandSync({ executable: 'node', args: ['-e', 'process.exit(7)'], cwd: process.cwd() })
    expect(fail.exitCode).toBe(7)
  })
})
