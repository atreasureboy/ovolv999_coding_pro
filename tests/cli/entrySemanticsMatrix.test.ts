/**
 * v0.4.1 C4 (entry semantics matrix) — single-task / stdin / --pipe are
 * three doors into the SAME engine, and must behave like it.
 *
 * Post-WS3 all three route through assembleEngine, so the observable
 * semantics are pinned here across the 3 doors × {completed, API-fail}:
 *   - completed: every door delivers the echo answer, exit 0;
 *   - API 401: every door exits NON-ZERO with the error visible and NO
 *     fabricated answer (the pipe ladder's exact 2 is pinned in
 *     pipeSpawn.test.ts; here the invariant is honest failure everywhere —
 *     pre-C4 the classic doors exited 0 off a dead API key);
 *   - a CLI `--model` override reaches the wire under every door.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
// @ts-expect-error fixture is a plain .mjs without types
import { startEchoServer } from '../fixtures/openaiEchoServer.mjs'
import { runCli, isolatedEnv } from './helpers.js'

const TIMEOUT = 180_000

type Door = (task: string, extra: string[]) => { args: string[]; stdin: string }

const DOORS: Record<string, Door> = {
  // ovolv999 "task" — positional single-task
  'single-task': (task, extra) => ({ args: [...extra, task], stdin: '' }),
  // echo task | ovolv999 — bare stdin, no flags
  'stdin': (task, extra) => ({ args: [...extra], stdin: task }),
  // echo task | ovolv999 --pipe
  '--pipe': (task, extra) => ({ args: ['--pipe', ...extra], stdin: task }),
}

describe('entry semantics matrix (v0.4.1 C4)', () => {
  let echo: { port: number; baseURL: string; close: () => Promise<void>; requests: Array<{ model: string; stream: boolean }> }
  let authFail: { port: number; baseURL: string; close: () => Promise<void>; requests: Array<{ model: string; stream: boolean }> }
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
    tmpHome = mkdtempSync(join(tmpdir(), 'ovolv999-matrix-home-'))
    tmpProj = mkdtempSync(join(tmpdir(), 'ovolv999-matrix-proj-'))
  })
  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* best-effort */ }
    try { rmSync(tmpProj, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('completed: every door delivers the answer and exits 0', async () => {
    for (const [door, build] of Object.entries(DOORS)) {
      const { args, stdin } = build(`matrix ${door} ok`, [])
      const run = await runCli(args, {
        stdin,
        cwd: tmpProj,
        env: isolatedEnv(tmpHome, { OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: echo.baseURL }),
      })
      expect(run.timedOut, `door ${door} timed out`).toBe(false)
      expect(run.code, `door ${door} exit code`).toBe(0)
      // The echo fixture mirrors the LAST USER MESSAGE into the assistant
      // reply prefixed with 'ECHO:'. single-task/stdin send the task raw
      // ('ECHO: <task>'); --pipe wraps it in the frozen buildPrompt context
      // envelope, so the reply echoes the whole wrapper. Both invariants
      // matter: 'ECHO:' proves a MODEL REPLY reached stdout (not just the
      // input printed back), and the task text proves it rode inside it.
      expect(run.stdout, `door ${door} carries a model reply`).toContain('ECHO:')
      expect(run.stdout, `door ${door} answer`).toContain(`matrix ${door} ok`)
    }
  }, TIMEOUT)

  it('API 401: every door fails honestly — non-zero exit, visible error, no fabricated answer', async () => {
    for (const [door, build] of Object.entries(DOORS)) {
      const { args, stdin } = build('matrix auth doom', [])
      const run = await runCli(args, {
        stdin,
        cwd: tmpProj,
        env: isolatedEnv(tmpHome, { OPENAI_API_KEY: 'wrong-key', OPENAI_BASE_URL: authFail.baseURL }),
      })
      expect(run.timedOut, `door ${door} timed out`).toBe(false)
      expect(run.code, `door ${door} must exit non-zero`).not.toBe(0)
      expect(run.stdout, `door ${door} must not fabricate an answer`).not.toContain('ECHO:')
      expect(
        run.stdout + run.stderr,
        `door ${door} must surface the failure`,
      ).toMatch(/✖|failed|authentication|incorrect api key|401/i)
    }
  }, TIMEOUT)

  it('a --model override reaches the wire under every door', async () => {
    for (const [door, build] of Object.entries(DOORS)) {
      const before = echo.requests.length
      const { args, stdin } = build(`matrix ${door} model`, ['--model', 'matrix-model-x'])
      const run = await runCli(args, {
        stdin,
        cwd: tmpProj,
        env: isolatedEnv(tmpHome, { OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: echo.baseURL }),
      })
      expect(run.timedOut, `door ${door} timed out`).toBe(false)
      expect(run.code, `door ${door} exit code`).toBe(0)
      const fresh = echo.requests.slice(before)
      expect(fresh.length, `door ${door} made a model call`).toBeGreaterThan(0)
      expect(
        fresh.every((r) => r.model === 'matrix-model-x'),
        `door ${door} sent the override model on the wire, got: ${JSON.stringify(fresh.map((r) => r.model))}`,
      ).toBe(true)
    }
  }, TIMEOUT)
})
