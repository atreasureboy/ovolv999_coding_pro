/**
 * v0.4.1 WS3 — real-CLI --pipe end-to-end (spawn-level truth).
 *
 * These are the only tests that can verify the golden-path contract of
 * pipe mode: stdout purity, the frozen sshRemote envelope keys, the exit
 * ladder, and that a corrupt global config cannot kill --version. They
 * spawn `tsx bin/ovogogogo.ts` against the fixture echo server with a
 * fully isolated HOME and project dir.
 *
 * Slow by nature (process spawn + engine boot per case) — each test
 * carries a 90s timeout; the file is meant for `npm run test`, not watch.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
// @ts-expect-error fixture is a plain .mjs without types
import { startEchoServer } from '../fixtures/openaiEchoServer.mjs'
import { runCli, isolatedEnv } from './helpers.js'

const TIMEOUT = 90_000

describe('--pipe real CLI (echo fixture)', () => {
  let echo: { port: number; baseURL: string; close: () => Promise<void> }
  let authFail: { port: number; baseURL: string; close: () => Promise<void> }
  let tmpHome: string
  let tmpProj: string

  beforeAll(async () => {
    echo = await startEchoServer({ mode: 'echo' })
    authFail = await startEchoServer({ mode: '401' })
  }, TIMEOUT)

  afterAll(async () => {
    await echo.close()
    await authFail.close()
  })

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'ovolv999-pipe-home-'))
    tmpProj = mkdtempSync(join(tmpdir(), 'ovolv999-pipe-proj-'))
  })
  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* best-effort */ }
    try { rmSync(tmpProj, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('text mode: stdout is the answer only, exit 0', async () => {
    const run = await runCli(['--pipe'], {
      stdin: 'hello golden path',
      cwd: tmpProj,
      env: isolatedEnv(tmpHome, { OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: echo.baseURL }),
    })
    expect(run.timedOut).toBe(false)
    expect(run.stderr).not.toContain('Error: no API key')
    expect(run.code).toBe(0)
    // The fixture echoes the user message; the answer must reach stdout.
    expect(run.stdout).toContain('hello golden path')
    // No UI chrome may leak onto stdout.
    expect(run.stdout).not.toContain('DEVELOPER AGENT RUNTIME')
    expect(run.stdout).not.toContain('\x1b[')
  }, TIMEOUT)

  it('json mode: stdout is one parseable envelope with frozen sshRemote keys', async () => {
    const run = await runCli(['--pipe', '--format', 'json'], {
      stdin: 'envelope check',
      cwd: tmpProj,
      env: isolatedEnv(tmpHome, { OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: echo.baseURL }),
    })
    expect(run.timedOut).toBe(false)
    expect(run.code).toBe(0)
    const parsed = JSON.parse(run.stdout) as {
      response: string
      stats: { inputTokens: number; outputTokens: number; durationMs: number }
    }
    expect(parsed.response).toContain('envelope check')
    expect(Object.keys(parsed.stats).sort()).toEqual(['durationMs', 'inputTokens', 'outputTokens'])
    // Stats are REAL costTracker values now (the fixture reports usage),
    // not char/4 estimates.
    expect(parsed.stats.inputTokens).toBeGreaterThan(0)
    expect(parsed.stats.outputTokens).toBeGreaterThan(0)
    expect(parsed.stats.durationMs).toBeGreaterThanOrEqual(0)
  }, TIMEOUT)

  it('API 401 → exit 2 with the error on stderr, stdout empty', async () => {
    const run = await runCli(['--pipe'], {
      stdin: 'will fail auth',
      cwd: tmpProj,
      env: isolatedEnv(tmpHome, { OPENAI_API_KEY: 'wrong-key', OPENAI_BASE_URL: authFail.baseURL }),
    })
    expect(run.timedOut).toBe(false)
    expect(run.code).toBe(2)
    expect(run.stderr.length).toBeGreaterThan(0)
    expect(run.stdout).toBe('')
  }, TIMEOUT)

  it('unknown flag value does not leak into the task', async () => {
    const run = await runCli(['--pipe', '--wat', 'watval', 'say hi'], {
      stdin: '',
      cwd: tmpProj,
      env: isolatedEnv(tmpHome, { OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: echo.baseURL }),
    })
    expect(run.timedOut).toBe(false)
    expect(run.code).toBe(0)
    // The echo server mirrors the full user message — if 'watval' leaked
    // into the task it would show up in the answer on stdout.
    expect(run.stdout).not.toContain('watval')
    expect(run.stdout).toContain('say hi')
    expect(run.stderr).toContain('--wat')
  }, TIMEOUT)

  it('--version survives a corrupt global settings.json (exit 0)', async () => {
    mkdirSync(join(tmpHome, '.ovogo'), { recursive: true })
    writeFileSync(join(tmpHome, '.ovogo', 'settings.json'), '{ "provider": { broken')
    const run = await runCli(['--version'], {
      cwd: tmpProj,
      env: isolatedEnv(tmpHome),
    })
    expect(run.timedOut).toBe(false)
    expect(run.code).toBe(0)
    expect(run.stdout).toMatch(/\d+\.\d+\.\d+/)
  }, TIMEOUT)

  it('--llm-only still serves the frozen raw single-shot path (sshRemote consumer)', async () => {
    const run = await runCli(['--llm-only'], {
      stdin: 'raw path',
      cwd: tmpProj,
      env: isolatedEnv(tmpHome, { OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: echo.baseURL }),
    })
    expect(run.timedOut).toBe(false)
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('raw path')
    expect(run.stdout).not.toContain('DEVELOPER AGENT RUNTIME')
  }, TIMEOUT)
})
