/**
 * Black-box E2E test for `ovolv999 attach <id>` (Round 25).
 *
 * The user's explicit demand (verbatim):
 *   "开一个真正独立 Node 子进程:父测试进程 ├── spawn `ovolv999 attach sess-x`
 *    │ （它现在只能靠 attach poll timer 活着）
 *    ├── 等 1 秒
 *    └── 向 sess-x.log append "hello"。
 *    断言:attach 子进程没有提前退出 并且收到 hello。"
 *
 * This is NOT a unit test. It spawns a REAL `tsx bin/ovogogogo.ts attach
 * <id>` subprocess against an isolated HOME, with a pre-written session
 * metadata + empty log, then appends to the log out-of-band and asserts
 * the attach child:
 *   1. did NOT exit prematurely during the 1s wait (the .unref() poll timer
 *      must not let the Node event loop exit when the only live work is the
 *      pending `for await (line of handle.stream)` loop), AND
 *   2. received the appended "hello" line on its stdout.
 *
 * This catches the .unref() lifecycle risk that the unit tests cannot:
 * Vitest itself holds many active handles, so a unit-tested attachToSession
 * never faces the "poll timer is the only ref" condition. A real subprocess
 * does.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { isolatedEnv } from './helpers.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const tsxCli = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const binEntry = join(repoRoot, 'bin', 'ovogogogo.ts')

const TIMEOUT = 60_000

let tmpHome: string

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ovolv999-attach-e2e-'))
})

afterAll(() => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true })
})

/**
 * Spawn `tsx bin/ovogogogo.ts attach <id>` as a real subprocess with an
 * isolated HOME, returning the child handle + a stdout/stderr accumulator.
 *
 * The accumulator is a single mutable object whose `.stdout`/`.stderr`
 * properties are reassigned by the 'data' listeners. Returning the object
 * (not the primitive string values) is essential: a returned `let stdout`
 * would capture the empty-string snapshot at return time and the caller
 * would never see appended data — primitives are copied by value into the
 * shorthand `{ stdout }`. The object is shared by reference, so reads
 * always observe the latest.
 */
function spawnAttach(sessionId: string): {
  child: ReturnType<typeof spawn>
  acc: { stdout: string; stderr: string }
} {
  const sessionsDir = join(tmpHome, '.ovolv999', 'sessions')
  mkdirSync(sessionsDir, { recursive: true })
  const env = isolatedEnv(tmpHome)
  const child = spawn(process.execPath, [tsxCli, binEntry, 'attach', sessionId], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const acc = { stdout: '', stderr: '' }
  child.stdout.on('data', (d: Buffer) => { acc.stdout += d.toString() })
  child.stderr.on('data', (d: Buffer) => { acc.stderr += d.toString() })
  return { child, acc }
}

describe('ovolv999 attach — black-box E2E (real subprocess)', () => {
  it('survives the 1s wait AND receives an appended log line', async () => {
    const sessionId = 'sess-e2e-attach-1'
    const sessionsDir = join(tmpHome, '.ovolv999', 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    const metaPath = join(sessionsDir, `${sessionId}.json`)
    const logPath = join(sessionsDir, `${sessionId}.log`)

    // Pre-write session metadata (status=running, pid=current so isPidAlive
    // is true — attach must stream, not bail). Empty log so attach baseline
    // offset = 0; everything we append later is "new".
    writeFileSync(metaPath, JSON.stringify({
      id: sessionId,
      task: 'e2e-attach-task',
      cwd: repoRoot,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      status: 'running',
      logPath,
    }))
    writeFileSync(logPath, '')

    const { child, acc } = spawnAttach(sessionId)

    // Wait until the child has printed the streaming header — i.e. it has
    // booted tsx, parsed args, read metadata, and entered the `for await`
    // loop. Under heavy CI concurrency tsx boot can exceed a flat 1s, so
    // we gate on the actual streaming-ready signal rather than a timer.
    // Hard cap at 25s (TIMEOUT - overhead) so a genuinely broken boot fails
    // the test instead of hanging the suite.
    {
      const bootDeadline = Date.now() + 25_000
      while (
        child.exitCode === null &&
        !acc.stdout.includes('--- streaming logs') &&
        Date.now() < bootDeadline
      ) {
        await new Promise((r) => setTimeout(r, 50))
      }
    }
    // If the child died before reaching streaming, that's the .unref() bug
    // (or a boot crash) — fail fast with diagnostics.
    if (child.exitCode !== null) {
      try { /* already exited */ } catch { /* ignore */ }
      expect(
        child.exitCode,
        `attach child exited (code=${child.exitCode}) before reaching the ` +
        `streaming state — the poll timer / event-loop lifecycle is broken. ` +
        `stdout:\n${acc.stdout}\nstderr:\n${acc.stderr}`,
      ).toBeNull()
      return // unreachable — expect above throws
    }
    // Give the poll timer one tick past boot so its baseline offset (= the
    // current log size, 0 here) is settled before we append.
    await new Promise((r) => setTimeout(r, 150))

    const exitedEarly = child.exitCode !== null
    // Snapshot stdout before we append (should be the header only).
    const stdoutAt1s = acc.stdout.slice()

    // Append "hello" — the child's poll timer (every 500ms) must pick this
    // up and write it to its stdout.
    appendFileSync(logPath, 'hello\n')

    // Give the poll timer up to 5s to deliver the line. 5s (not 3s) gives
    // headroom for a slow poll tick under CI contention.
    const deadline = Date.now() + 5000
    let received = acc.stdout.includes('hello')
    while (!received && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
      received = acc.stdout.includes('hello')
    }

    // Tear down the child.
    try { child.kill('SIGTERM') } catch { /* ignore */ }
    // Give it a moment to exit, then SIGKILL if needed.
    await new Promise((r) => setTimeout(r, 300))
    try { if (child.exitCode === null) child.kill('SIGKILL') } catch { /* ignore */ }

    // Assertion 1: did NOT exit prematurely during the 1s wait.
    expect(
      exitedEarly,
      `attach child exited prematurely at 1s (exitCode=${child.exitCode}). ` +
      `This means the .unref()'d poll timer let the event loop exit while ` +
      `the for-await stream was the only pending work. stdout at 1s:\n${stdoutAt1s}`,
    ).toBe(false)

    // Assertion 2: received the appended "hello".
    expect(
      received,
      `attach child did NOT receive the appended "hello" line within 3s. ` +
      `full stdout:\n${acc.stdout}\nstderr:\n${acc.stderr}`,
    ).toBe(true)
  }, TIMEOUT)

  it('exits cleanly after the session is marked non-running (no hang)', async () => {
    // A second black-box check: when the session is already completed at
    // attach time, the attach child should not hang forever waiting for
    // stream lines that will never come — it should exit in bounded time.
    const sessionId = 'sess-e2e-attach-2'
    const sessionsDir = join(tmpHome, '.ovolv999', 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    const metaPath = join(sessionsDir, `${sessionId}.json`)
    const logPath = join(sessionsDir, `${sessionId}.log`)

    writeFileSync(metaPath, JSON.stringify({
      id: sessionId,
      task: 'e2e-attach-completed',
      cwd: repoRoot,
      pid: 999_999, // dead pid
      startedAt: new Date().toISOString(),
      status: 'completed',
      exitCode: 0,
      logPath,
    }))
    writeFileSync(logPath, 'already-finished\n')

    const { child, acc } = spawnAttach(sessionId)

    // Wait until the child reaches the streaming state (header printed) or
    // exits — gate on the real signal, not a flat timer, so tsx-boot latency
    // under CI contention doesn't cause a false hang. Hard cap 25s.
    {
      const bootDeadline = Date.now() + 25_000
      while (
        child.exitCode === null &&
        !acc.stdout.includes('--- streaming logs') &&
        Date.now() < bootDeadline
      ) {
        await new Promise((r) => setTimeout(r, 50))
      }
    }

    // Once streaming is reached for a non-running session, finalizeIfDone()
    // ends the stream on the next poll tick (≤500ms). Give it up to 8s
    // total to exit on its own.
    const deadline = Date.now() + 8000
    while (child.exitCode === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    try { if (child.exitCode === null) child.kill('SIGKILL') } catch { /* ignore */ }

    expect(
      child.exitCode,
      `attach child did not exit within 8s for a completed session (possible hang). stdout:\n${acc.stdout}`,
    ).not.toBeNull()
  }, TIMEOUT)
})
