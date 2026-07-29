/**
 * v0.4.1 WS2 — the no-key gate, at spawn level (the only way to prove
 * real TTY branching + the wizard EOF fix end-to-end).
 *
 * A spawned child with piped stdio is NON-TTY by construction, so these
 * cover: the actionable stderr block + exit 1 (wizard must never run for
 * a non-interactive caller), and the `init < EOF` hang regression that
 * pre-WS2 froze until the watchdog killed the child.
 *
 * The interactive branch (TTY → one question → wizard → probe → fall
 * through) needs a real PTY — that path is covered by the wizard unit
 * tests + providerProbe tests, and verified manually per CLAUDE.md.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runCli, isolatedEnv } from './helpers.js'

const TIMEOUT = 90_000

describe('first-run gate (real CLI, non-TTY spawn)', () => {
  let tmpHome: string
  let tmpProj: string

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'ovolv999-firstrun-home-'))
    tmpProj = mkdtempSync(join(tmpdir(), 'ovolv999-firstrun-proj-'))
  })
  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* best-effort */ }
    try { rmSync(tmpProj, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('no key + non-TTY → actionable stderr block, exit 1, wizard never runs', async () => {
    const run = await runCli([], {
      stdin: '',
      cwd: tmpProj,
      env: isolatedEnv(tmpHome, {}),
    })
    expect(run.timedOut).toBe(false)
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('no API key is configured')
    expect(run.stderr).toContain('export OPENAI_API_KEY')
    expect(run.stderr).toContain('ovolv999 init')
    // The interactive wizard must not run for a non-TTY caller (it would
    // hang on the closed stdin — pre-WS2 this whole path was a dead end).
    expect(run.stdout + run.stderr).not.toContain('first-run setup')
    // stdout stays clean for machine consumers.
    expect(run.stdout).toBe('')
  }, TIMEOUT)

  it('`init` with closed stdin exits cleanly instead of hanging (EOF sentinel regression)', async () => {
    const run = await runCli(['init'], {
      stdin: '',
      cwd: tmpProj,
      env: isolatedEnv(tmpHome, {}),
    })
    // Pre-WS2: rl.question never fired → timedOut true (30s watchdog kill).
    expect(run.timedOut).toBe(false)
    // EOF answers defaulted through to the manual path's key gate → not
    // configured → the init command exits 1.
    expect(run.code).toBe(1)
    expect(run.stdout).toContain('API key is required')
  }, TIMEOUT)
})
