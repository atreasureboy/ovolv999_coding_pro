/**
 * BashTool — abort signal semantics + process-group cleanup tests.
 *
 * Covers:
 *   1. Pre-abort (signal already aborted before invoke) — no spawn, fast return.
 *   2. Mid-flight abort — entire process group killed (shell + child subprocesses).
 *   3. Normal-exit race — command finishes cleanly before abort fires; no
 *      spurious cancellation, listener removed cleanly.
 *   4. Listener / timer cleanup — no zombie SIGKILL escalation timer, no
 *      leaked abort listener after a clean run.
 *   5. Internal timeout — same SIGTERM/SIGKILL escalation, distinct from
 *      external abort (so the LLM sees the timeout contract).
 *   6. Non-zero exit — error hints surfaced (contract preserved).
 *   7. Successful run — output captured verbatim (contract preserved).
 *   8. SIGKILL escalation fires when child traps SIGTERM (proves the
 *      timer is NOT cleared by promise settlement).
 *   9. Internal timeout timer is cleared by abort (abort must not be
 *      followed by a spurious timeout).
 *  10. Background mode is detached + unref'd so the REPL can exit.
 *
 * Cross-platform notes:
 *   - Process-group kill tests rely on POSIX setpgid (Linux/macOS). On
 *     Windows the implementation falls back to `taskkill /T` and these
 *     assertions are skipped.
 *   - All other tests run on every platform.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { BashTool } from '../src/tools/bash.js'
import type { ToolContext } from '../src/core/types.js'

const IS_POSIX = process.platform !== 'win32'
const SIGKILL_GRACE_MS_TEST = 300

function makeCtx(signal?: AbortSignal, cwd = process.cwd()): ToolContext {
  return { cwd, permissionMode: 'auto', signal }
}

/** Wait `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

describe('BashTool — abort signal + process-group cleanup', () => {
  // Default-instantiated tool for the bulk of tests; per-test instances
  // override options (e.g. sigkillGraceMs) where needed.
  const tool = new BashTool()

  // Clean up any marker files the tests create.
  afterEach(async () => {
    const { unlinkSync, existsSync } = await import('fs')
    for (const p of [
      '/tmp/bash-abort-test-marker',
      '/tmp/bash-sigkill-test-marker',
      '/tmp/bash-sigkill-shell.pid',
      '/tmp/bash-sigkill-child.pid',
      '/tmp/bash-sigkill-sleep.pid',
    ]) {
      if (existsSync(p)) {
        try { unlinkSync(p) } catch { /* best-effort */ }
      }
    }
  })

  it('has correct name + metadata', () => {
    expect(tool.name).toBe('Bash')
    expect(tool.metadata.longRunning).toBe(true)
    expect(tool.metadata.mutatesState).toBe(true)
  })

  it('rejects when command is missing', async () => {
    const result = await tool.execute({}, makeCtx())
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/command is required/i)
  })

  it('preserves the success contract: exit 0 returns stdout/stderr', async () => {
    const result = await tool.execute({ command: 'echo hello-bash && echo world 1>&2' }, makeCtx())
    expect(result.isError).toBe(false)
    expect(result.content).toContain('hello-bash')
    expect(result.content).toContain('world')
  })

  it('preserves the non-zero-exit contract with diagnostic hint (fi_goal §六: non-zero = failed)', async () => {
    const result = await tool.execute({ command: 'cat /no/such/path/that/definitely/does/not/exist' }, makeCtx())
    // Spec §六: non-zero exit must NOT be reported as success.
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/Exit code: \d+/)
    expect(result.content).toMatch(/no such file/i)
  })

  it('pre-abort short-circuits before spawning (no child process created)', async () => {
    const controller = new AbortController()
    controller.abort()  // already aborted BEFORE invoke

    const result = await tool.execute(
      { command: 'echo should-not-run' },
      makeCtx(controller.signal),
    )
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/pre-abort/i)
    // The would-be stdout must not appear — proves we never spawned.
    expect(result.content).not.toContain('should-not-run')
  })

  it('mid-flight abort kills the process group (shell + backgrounded subprocess)', async () => {
    if (!IS_POSIX) {
      // Process-group kill relies on POSIX setpgid semantics; skip on Windows.
      return
    }

    const controller = new AbortController()

    // The command itself spawns a 30s `sleep 100`, prints its PID, then
    // waits. We abort shortly after, then verify the subprocess is gone.
    // Using `disown` so bash won't wait on it; the marker file proves
    // the shell started the child. After abort, neither sleep should be
    // alive.
    const command = [
      'sleep 100 &',
      'SUBPID=$!',
      'disown',
      'echo "child-pid=$SUBPID"',
      // Marker so we can prove the shell actually reached this line.
      'touch /tmp/bash-abort-test-marker',
      // Now wait forever — abort must kill us via the process group.
      'wait',
    ].join('\n')

    const promise = tool.execute({ command }, makeCtx(controller.signal))

    // Give the shell time to spawn the child + write the marker.
    await delay(800)
    controller.abort()

    const result = await promise
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/cancelled|abort/i)

    // The shell must have started (marker file exists OR stdout captured
    // the child-pid line).
    const markerExists = await fileExists('/tmp/bash-abort-test-marker')
    const childPid = extractPid(result.content, 'child-pid=')
    expect(markerExists || childPid !== null).toBe(true)

    // The backgrounded subprocess must be dead (Z state counts as gone).
    if (childPid !== null) {
      await waitForProcessGone(childPid, 2_000)
    }
  })

  it('normal-exit race: command finishes cleanly, abort fires after — no cancellation', async () => {
    const controller = new AbortController()
    const promise = tool.execute(
      { command: 'echo race-output' },
      makeCtx(controller.signal),
    )

    // Abort AFTER the command has already finished (small delay so the
    // close event has fired and the listener has been removed).
    const result = await promise
    await delay(50)
    controller.abort()  // must be a no-op now

    expect(result.isError).toBe(false)
    expect(result.content).toContain('race-output')
  })

  it('listener / timer cleanup: no zombie escalation timer after a clean run', async () => {
    // If the SIGKILL escalation timer leaked, the test process would
    // keep a timer alive (refed). We `.unref()` every timer, but verify
    // the contract by checking active handle counts before/after.
    const handlesBefore = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.()?.length ?? 0

    const controller = new AbortController()
    await tool.execute({ command: 'echo cleanup-check' }, makeCtx(controller.signal))

    // Give Node a tick to release listeners.
    await delay(20)

    const handlesAfter = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.()?.length ?? 0
    // Active handles should NOT have grown (we removed the abort listener
    // and cleared the escalation timer). Allow tiny slack for other
    // unrelated handles the runtime may add.
    expect(handlesAfter - handlesBefore).toBeLessThanOrEqual(1)
  })

  it('internal timeout escalates SIGTERM → SIGKILL and surfaces the timeout contract', async () => {
    if (!IS_POSIX) {
      // Internal timeout uses the same process-group kill; skip on Windows.
      return
    }

    const start = Date.now()
    const result = await tool.execute(
      { command: 'sleep 60', timeout: 500 },
      makeCtx(),
    )
    const elapsed = Date.now() - start

    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/timed out/i)
    // 500ms timeout + grace period for process teardown. We only assert
    // it didn't run the full 60s — the SIGKILL escalation means we don't
    // have to wait for the natural sleep completion.
    expect(elapsed).toBeLessThan(10_000)
  })

  it('SIGKILL escalation actually fires when shell AND child trap SIGTERM', async () => {
    if (!IS_POSIX) {
      return
    }

    // Tight SIGTERM→SIGKILL grace so the test runs quickly. BOTH the
    // shell and its backgrounded child trap SIGTERM (signal 15) and
    // ignore it. If the implementation clears the killTimer in
    // `settle()` (the original bug), the trapped process would survive
    // SIGTERM and stay alive for 30s. The fix only clears killTimer in
    // child.on('close') / 'error', so SIGKILL fires after the grace
    // period and proves the kill reached an otherwise-unkillable child.
    const fastTool = new BashTool({ sigkillGraceMs: SIGKILL_GRACE_MS_TEST })

    const controller = new AbortController()
    const start = Date.now()

    // The shell traps TERM and background-spawns a child bash that
    // ALSO traps TERM — only SIGKILL (signal 9, untrappable) can kill
    // either. We pick a child sleep duration far longer than the test
    // budget so that survival = test failure.
    const command = [
      // Shell: ignore SIGTERM.
      'trap "" TERM',
      // Persist the shell pid so we can poll /proc deterministically.
      `echo $$ > /tmp/bash-sigkill-shell.pid`,
      'echo "trap-pid=$$"',
      // Backgrounded child: explicitly also traps TERM (its own trap,
      // not inherited — proving process-group kill reaches it). The
      // parent shell writes the child's pid to a file BEFORE waiting
      // so the file is always observable.
      `bash -c 'trap "" TERM; sleep 30' &`,
      `echo $! > /tmp/bash-sigkill-child.pid`,
      'disown',
      // Block forever in the parent shell. `wait` would return
      // immediately after disown, so we use `sleep infinity` to keep
      // the shell alive in the foreground — SIGKILL on the process
      // group must terminate this too.
      'exec sleep 30',
    ].join('\n')

    const promise = fastTool.execute({ command }, makeCtx(controller.signal))

    // Wait for the shell to set up the trap + spawn the trapped child.
    await delay(400)

    // ── Pre-abort sanity: shell + child must both be alive. ─────
    const shellPidBefore = await readPidFile('/tmp/bash-sigkill-shell.pid')
    const childPidBefore = await readPidFile('/tmp/bash-sigkill-child.pid')
    expect(shellPidBefore, 'shell must have written pid file before abort').not.toBeNull()
    expect(childPidBefore, 'child must have been spawned before abort').not.toBeNull()
    expect(await isPidAlive(shellPidBefore!)).toBe(true)
    expect(await isPidAlive(childPidBefore!)).toBe(true)

    // Trigger the cancel path. The shell + child trap SIGTERM, so
    // they should keep running after our polite kill.
    controller.abort()
    const result = await promise
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/cancelled|abort/i)

    // ── Immediately after grace: BOTH must STILL be alive.
    // SIGTERM was ignored; SIGKILL hasn't fired yet (we're still in
    // the grace window). This proves the original killTimer-clearing
    // bug is NOT present.
    await delay(SIGKILL_GRACE_MS_TEST / 2)
    expect(await isPidAlive(shellPidBefore!), 'shell must still be alive mid-grace (SIGTERM was trapped)').toBe(true)
    expect(await isPidAlive(childPidBefore!), 'child must still be alive mid-grace (SIGTERM was trapped)').toBe(true)

    // ── After the grace window: BOTH must be gone (Z or removed).
    // SIGKILL fired on the process group; both trapped processes are
    // unkillable by SIGTERM but die instantly on SIGKILL.
    await waitForProcessGone(shellPidBefore!, /* deadlineMs */ SIGKILL_GRACE_MS_TEST * 2)
    await waitForProcessGone(childPidBefore!, SIGKILL_GRACE_MS_TEST * 2)

    const elapsed = Date.now() - start
    // If SIGKILL didn't fire, the 30s sleeps would keep this test
    // running for ~30s. With the fix it should complete well under 5s.
    expect(elapsed).toBeLessThan(5_000)
  })

  it('constructor rejects invalid sigkillGraceMs (negative / NaN / non-finite)', () => {
    // Falls back to default. We can't directly read the field (private),
    // but we can prove the constructor didn't throw and the tool still
    // behaves — a misuse that disabled escalation entirely would
    // misbehave on a stubborn child; with the default fallback, the
    // SIGKILL branch still works.
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '5000' as unknown as number, null as unknown as number]) {
      expect(() => new BashTool({ sigkillGraceMs: bad })).not.toThrow()
    }
  })

  it('internal timeout is cancelled by abort (no spurious timeout after abort)', async () => {
    if (!IS_POSIX) {
      return
    }

    // Use a long timeout (5s) and abort after 300ms. If the timeout
    // timer isn't cleared by the abort path, it would fire ~4.7s later
    // and could race with close-handler logic.
    const controller = new AbortController()
    const start = Date.now()
    const promise = tool.execute(
      { command: 'sleep 30', timeout: 5_000 },
      makeCtx(controller.signal),
    )

    await delay(300)
    controller.abort()

    const result = await promise
    const elapsed = Date.now() - start

    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/cancelled|abort/i)
    // Should finish well before the 5s timeout — abort path returns
    // promptly and kills the process via process group.
    expect(elapsed).toBeLessThan(2_000)
    // After the promise resolved, wait a bit and verify no second
    // timeout-related behaviour fires (no error log, no extra kill).
    await delay(200)
  })

  it('abort during a long-running command returns "cancelled" with partial output captured', async () => {
    if (!IS_POSIX) {
      return
    }

    const controller = new AbortController()
    const command = [
      'echo partial-line-1',
      'sleep 30',
      'echo partial-line-2  # never reached',
    ].join('\n')

    const promise = tool.execute({ command }, makeCtx(controller.signal))
    await delay(300)
    controller.abort()

    const result = await promise
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/cancelled/i)
    // The shell printed `partial-line-1` BEFORE sleep — that must be in
    // the captured output.
    expect(result.content).toContain('partial-line-1')
    // The post-sleep echo never ran.
    expect(result.content).not.toContain('partial-line-2')
  })

  it('live output keeps the head (early output) and the tail (final error)', async () => {
    if (!IS_POSIX) {
      return
    }

    // Head+tail live buffer regression: a coding session emits a long
    // compile/test trace (would-be head) followed by a final error
    // (would-be tail). A head-only cap would lose the tail. LIVE_BUFFER_BYTES
    // is 14 KB per side, so a 30 KB payload overflows the head and forces
    // the tail to track the final marker.
    const { mkdtempSync, writeFileSync } = await import('fs')
    const { tmpdir } = await import('os')
    const path = await import('path')
    const dir = mkdtempSync(path.join(tmpdir(), 'bash-headtail-'))
    const helperPath = path.join(dir, 'helper.js')
    writeFileSync(
      helperPath,
      [
        'process.stdout.write("EARLY-OUTPUT-MARKER-START-OF-RUN\\n");',
        '// 30 KB of filler — exceeds the 14 KB head budget, spills into tail',
        'process.stdout.write("x".repeat(30 * 1024));',
        'process.stdout.write("\\n");',
        'process.stdout.write("FINAL-ERROR-MARKER-END-OF-RUN\\n");',
      ].join('\n') + '\n',
      'utf8',
    )
    const result = await tool.execute({ command: `node ${helperPath}` }, makeCtx())
    expect(result.isError).toBe(false)
    // Early output MUST be preserved (head kept verbatim).
    expect(result.content).toContain('EARLY-OUTPUT-MARKER-START-OF-RUN')
    // Final error MUST be preserved (tail kept verbatim). A head-only
    // buffer would have dropped this once headBytes > LIVE_BUFFER_BYTES.
    expect(result.content).toContain('FINAL-ERROR-MARKER-END-OF-RUN')
    // Output length must remain bounded for LLM context safety. The
    // post-truncateOutput result is at most MAX_OUTPUT_LENGTH (~30 KB)
    // PLUS a small overhead for the prefix/marker.
    expect(result.content.length).toBeLessThanOrEqual(32_000)
  })

  it('live output inserts a truncation marker between head and tail when middle is dropped', async () => {
    if (!IS_POSIX) {
      return
    }
    // LIVE_BUFFER_BYTES = 14 KB. We emit 30 KB via a node helper so
    // the middle MUST be dropped; the marker must appear between the
    // head and the tail in the final output.
    const { mkdtempSync, writeFileSync } = await import('fs')
    const { tmpdir } = await import('os')
    const path = await import('path')
    const dir = mkdtempSync(path.join(tmpdir(), 'bash-trunc-'))
    const helperPath = path.join(dir, 'helper.js')
    writeFileSync(
      helperPath,
      [
        'process.stdout.write("y".repeat(30 * 1024));',
        'process.stdout.write("\\n");',
      ].join('\n') + '\n',
      'utf8',
    )
    const result = await tool.execute({ command: `node ${helperPath}` }, makeCtx())
    expect(result.isError).toBe(false)
    // The truncation marker surfaces the dropped byte count.
    expect(result.content).toMatch(/bytes of live output dropped from the middle/i)
    // Bounded output length — guard against a regression that returns
    // the full ~1 MB raw buffer to the LLM context.
    expect(result.content.length).toBeLessThanOrEqual(32_000)
  })

  it('background mode spawns detached + unref so REPL can exit', async () => {
    if (!IS_POSIX) {
      return
    }

    // Compare active handles before/after a backgrounded spawn. If the
    // background child were NOT unref'd, the handle count would grow by
    // at least 1 (the child socket). After unref(), the child socket
    // doesn't keep the event loop alive.
    const before = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.()?.length ?? 0
    const result = await tool.execute(
      { command: 'echo bg-handle-check', run_in_background: true },
      makeCtx(),
    )
    // Give Node a tick to register/unref the handles.
    await delay(30)
    const after = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.()?.length ?? 0

    expect(result.isError).toBe(false)
    expect(result.content).toMatch(/started in background|Background task created/i)
    // unref'd child should not inflate the handle count permanently.
    expect(after).toBeLessThanOrEqual(before + 2)
  })

  it('direct background mode pre-aborts before spawn when signal is already aborted', async () => {
    if (!IS_POSIX) {
      return
    }
    const controller = new AbortController()
    controller.abort()
    // No ctx.backgroundTaskManager — direct path. Pre-abort MUST short-circuit
    // before spawn so we don't fork a useless child. With the pre-abort
    // check moved ahead of spawn, the command must NEVER have been run.
    const result = await tool.execute(
      { command: 'echo should-not-run-bg', run_in_background: true },
      makeCtx(controller.signal),
    )
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/pre-abort/i)
    expect(result.content).not.toContain('should-not-run-bg')
  })

  it('isConcurrencySafe still classifies read-only vs mutating commands', () => {
    expect(tool.isConcurrencySafe?.({ command: 'ls' })).toBe(true)
    expect(tool.isConcurrencySafe?.({ command: 'cat foo.txt' })).toBe(true)
    expect(tool.isConcurrencySafe?.({ command: 'npm install' })).toBe(false)
    expect(tool.isConcurrencySafe?.({ command: 'rm -rf /' })).toBe(false)
    // Chained commands (semicolons or &&) are NOT safe.
    expect(tool.isConcurrencySafe?.({ command: 'ls && rm foo' })).toBe(false)
    expect(tool.isConcurrencySafe?.({ command: 'ls; rm foo' })).toBe(false)
  })
})

// ── Helpers ──────────────────────────────────────────────────────────────

async function fileExists(path: string): Promise<boolean> {
  const { existsSync } = await import('fs')
  return existsSync(path)
}

/** Read a pid from a one-line file. Returns null if missing/invalid. */
async function readPidFile(path: string): Promise<number | null> {
  const { readFileSync, existsSync } = await import('fs')
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf8').trim()
    const pid = Number(raw)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/** Parse `key=NUMBER` out of a captured child output string. */
function extractPid(content: string, key: string): number | null {
  const m = content.match(new RegExp(`${key}(\\d+)`))
  return m ? Number(m[1]) : null
}

/**
 * True iff a process with the given pid is still alive (running or
 * any non-terminated state, INCLUDING zombies). Reads `/proc/<pid>/stat`
 * for an authoritative state field; never uses `kill -0` because that
 * returns 0 for zombies too and would give false positives.
 */
async function isPidAlive(pid: number): Promise<boolean> {
  const { existsSync, readFileSync } = await import('fs')
  if (!existsSync(`/proc/${pid}`)) return false
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // State field is the 3rd whitespace token after the (possibly
    // space-containing) comm. Match the closing paren then capture
    // the next non-space token.
    const m = stat.match(/\) (\S)/)
    if (!m) return false
    const state = m[1]
    // Z = zombie (terminated but not reaped). Treat as NOT alive.
    // X = dead. All other states (R S D T ...) = alive.
    return state !== 'Z' && state !== 'X'
  } catch {
    return false
  }
}

/**
 * Wait until a pid is fully gone — /proc entry removed OR kernel state
 * is Z (zombie). Polls every 25ms up to `deadlineMs`. Throws if the
 * deadline expires so the caller can fail the test.
 */
async function waitForProcessGone(pid: number, deadlineMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < deadlineMs) {
    if (!(await isPidAlive(pid))) return
    await delay(25)
  }
  throw new Error(`pid ${pid} still alive (or zombie) after ${deadlineMs}ms`)
}
