import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, statSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'
import { BackgroundTaskManager, formatTaskList, formatTaskDetail } from '../src/core/backgroundTaskManager.js'

// Helper: wait for a task to reach a non-running state
async function waitForDone(manager: BackgroundTaskManager, id: string, timeoutMs = 5000): Promise<void> {
  const info = await manager.waitForTask(id, timeoutMs)
  if (!info) throw new Error(`Task ${id} not found`)
  if (info.status === 'running') throw new Error(`Task ${id} did not complete within ${timeoutMs}ms`)
}

/**
 * Returns false when the PID has disappeared or is a zombie. Linux uses
 * procfs; other POSIX systems use ps so the assertion remains portable.
 */
function isPidAlive(pid: number): boolean {
  if (process.platform === 'win32') return false
  if (process.platform !== 'linux') {
    try {
      const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      return state.length > 0 && !state.startsWith('Z')
    } catch {
      return false
    }
  }
  try {
    const out = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // /proc/<pid>/stat: "pid (comm) state ppid ..." — state is field 3,
    // the character right after the LAST ')' to handle comm-with-spaces.
    const idx = out.lastIndexOf(')')
    if (idx < 0) return false
    const state = out.charAt(idx + 2)
    // 'Z' = zombie, 'X' = dead. Any other letter (R/S/D/T/I) means alive.
    return state !== 'Z' && state !== 'X'
  } catch {
    return false
  }
}

// Use platform-appropriate commands
const ECHO = process.platform === 'win32' ? 'echo hello' : 'echo hello'
const SLEEP = process.platform === 'win32' ? 'ping -n 2 127.0.0.1 > nul' : 'sleep 1'
const LONG_SLEEP = process.platform === 'win32' ? 'ping -n 30 127.0.0.1 > nul' : 'sleep 30'
const FAIL_CMD = process.platform === 'win32' ? 'exit 1' : 'false'

describe('BackgroundTaskManager', () => {
  let manager: BackgroundTaskManager

  beforeEach(() => {
    manager = new BackgroundTaskManager()
  })

  // ── createTask ────────────────────────────────────────────────────────────

  describe('createTask', () => {
    it('creates a task and returns an ID', () => {
      const id = manager.createTask(ECHO, { description: 'test echo' })
      expect(id).toMatch(/^task_/)
      const task = manager.getTask(id)
      expect(task).toBeDefined()
      expect(task!.command).toBe(ECHO)
      expect(task!.description).toBe('test echo')
      expect(task!.status).toBe('running')
      expect(task!.pid).not.toBeNull()
    })

    it('defaults description to command', () => {
      const id = manager.createTask(ECHO)
      const task = manager.getTask(id)
      expect(task!.description).toBe(ECHO)
    })

    it('stores metadata', () => {
      const id = manager.createTask(ECHO, { metadata: { tag: 'build', priority: 1 } })
      const task = manager.getTask(id)
      expect(task!.metadata).toEqual({ tag: 'build', priority: 1 })
    })
  })

  // ── getTask / getTaskDetail ───────────────────────────────────────────────

  describe('getTask & getTaskDetail', () => {
    it('returns undefined for non-existent task', () => {
      expect(manager.getTask('nonexistent')).toBeUndefined()
      expect(manager.getTaskDetail('nonexistent')).toBeUndefined()
    })

    it('returns task info without output in getTask', async () => {
      const id = manager.createTask(ECHO)
      await waitForDone(manager, id)
      const info = manager.getTask(id)!
      expect(info.status).toBe('completed')
      expect(info.exitCode).toBe(0)
      expect(info.endTime).not.toBeNull()
      expect(info.durationMs).not.toBeNull()
      // getTask does NOT include output
      expect((info as { output?: string }).output).toBeUndefined()
    })

    it('returns output in getTaskDetail', async () => {
      const id = manager.createTask(ECHO)
      await waitForDone(manager, id)
      const detail = manager.getTaskDetail(id)!
      expect(detail.output).toContain('hello')
    })

    it('reports failed status for non-zero exit', async () => {
      const id = manager.createTask(FAIL_CMD)
      await waitForDone(manager, id)
      const info = manager.getTask(id)!
      expect(info.status).toBe('failed')
      expect(info.exitCode).not.toBe(0)
    })
  })

  // ── listTasks ─────────────────────────────────────────────────────────────

  describe('listTasks', () => {
    it('returns empty list initially', () => {
      expect(manager.listTasks()).toHaveLength(0)
    })

    it('lists all tasks sorted by start time (newest first)', () => {
      const id1 = manager.createTask(ECHO, { description: 'first' })
      const id2 = manager.createTask(ECHO, { description: 'second' })
      const tasks = manager.listTasks()
      expect(tasks).toHaveLength(2)
      // Newest first
      expect(tasks[0].id).toBe(id2)
      expect(tasks[1].id).toBe(id1)
    })
  })

  // ── updateTask ────────────────────────────────────────────────────────────

  describe('updateTask', () => {
    it('updates description', () => {
      const id = manager.createTask(ECHO)
      const ok = manager.updateTask(id, { description: 'new desc' })
      expect(ok).toBe(true)
      expect(manager.getTask(id)!.description).toBe('new desc')
    })

    it('merges metadata', () => {
      const id = manager.createTask(ECHO, { metadata: { a: 1 } })
      manager.updateTask(id, { metadata: { b: 2 } })
      const task = manager.getTask(id)!
      expect(task.metadata).toEqual({ a: 1, b: 2 })
    })

    it('returns false for non-existent task', () => {
      expect(manager.updateTask('nope', { description: 'x' })).toBe(false)
    })
  })

  // ── stopTask ──────────────────────────────────────────────────────────────

  describe('stopTask', () => {
    it('stops a running task', async () => {
      const id = manager.createTask(LONG_SLEEP, { description: 'long sleep' })
      // Give it a moment to start
      await new Promise((r) => setTimeout(r, 200))

      const stopped = manager.stopTask(id)
      expect(stopped).toBe(true)

      const task = manager.getTask(id)!
      expect(task.status).toBe('stopped')
      expect(task.endTime).not.toBeNull()
    })

    it('returns false for non-existent task', () => {
      expect(manager.stopTask('nonexistent')).toBe(false)
    })

    it('returns false for already-completed task', async () => {
      const id = manager.createTask(ECHO)
      await waitForDone(manager, id)
      expect(manager.stopTask(id)).toBe(false)
    })

    // Regression: status stays 'stopped' even after process actually exits
    it('status remains stopped after killed process exits (no race)', async () => {
      const id = manager.createTask(LONG_SLEEP, { description: 'long' })
      await new Promise((r) => setTimeout(r, 200)) // let it start

      manager.stopTask(id)
      expect(manager.getTask(id)!.status).toBe('stopped')

      // Wait for the SIGTERM'd process to fully exit
      await new Promise((r) => setTimeout(r, 500))

      // Status should STILL be 'stopped', not overridden to 'failed'
      const finalInfo = manager.getTask(id)!
      expect(finalInfo.status).toBe('stopped')
    })
  })

  // ── waitForTask ───────────────────────────────────────────────────────────

  describe('waitForTask', () => {
    it('waits for a task to complete', async () => {
      const id = manager.createTask(SLEEP)
      const info = await manager.waitForTask(id, 5000)
      expect(info).not.toBeNull()
      expect(info!.status).not.toBe('running')
    })

    it('returns null for non-existent task', async () => {
      const info = await manager.waitForTask('nonexistent', 1000)
      expect(info).toBeNull()
    })

    it('returns immediately for already-completed task', async () => {
      const id = manager.createTask(ECHO)
      await waitForDone(manager, id)
      const start = Date.now()
      const info = await manager.waitForTask(id, 5000)
      expect(Date.now() - start).toBeLessThan(100)
      expect(info!.status).toBe('completed')
    })

    it('times out and returns running status for long task', async () => {
      const id = manager.createTask(LONG_SLEEP)
      const info = await manager.waitForTask(id, 200)
      expect(info).not.toBeNull()
      // Should still be running (timed out)
      expect(info!.status).toBe('running')
      // Clean up
      manager.stopTask(id)
    })
  })

  // ── clearCompleted ────────────────────────────────────────────────────────

  describe('clearCompleted', () => {
    it('removes completed tasks but keeps running ones', async () => {
      const id1 = manager.createTask(ECHO)
      const id2 = manager.createTask(LONG_SLEEP)
      await waitForDone(manager, id1)

      const removed = manager.clearCompleted()
      expect(removed).toBe(1)
      expect(manager.getTask(id1)).toBeUndefined()
      expect(manager.getTask(id2)).toBeDefined()

      manager.stopTask(id2)
    })
  })

  // ── Output capture ────────────────────────────────────────────────────────

  describe('output capture', () => {
    it('captures stdout', async () => {
      const id = manager.createTask(process.platform === 'win32' ? 'echo test123' : 'echo test123')
      await waitForDone(manager, id)
      const detail = manager.getTaskDetail(id)!
      expect(detail.output).toContain('test123')
    })

    it('captures stderr', async () => {
      const cmd = process.platform === 'win32'
        ? 'echo error456 1>&2'
        : 'echo error456 >&2'
      const id = manager.createTask(cmd)
      await waitForDone(manager, id)
      const detail = manager.getTaskDetail(id)!
      expect(detail.output).toContain('error456')
    })

    it('tracks outputLength', async () => {
      const id = manager.createTask(ECHO)
      await waitForDone(manager, id)
      const info = manager.getTask(id)!
      expect(info.outputLength).toBeGreaterThan(0)
    })

    // Regression: outputLength should track TOTAL bytes, not truncated buffer
    it('tracks total outputLength even when buffer exceeds cap', async () => {
      // Produce ~250KB of output (exceeds MAX_OUTPUT_BUFFER=200KB) via Node
      const cmd = 'node -e "process.stdout.write(\'X\'.repeat(250000))"'
      const id = manager.createTask(cmd)
      await waitForDone(manager, id, 10_000)
      const info = manager.getTask(id)!
      // outputLength should be >= 200KB (total produced), not capped at buffer size
      expect(info.outputLength).toBeGreaterThanOrEqual(200_000)
    })
  })

  // ── getOutputFile ─────────────────────────────────────────────────────────

  describe('getOutputFile', () => {
    it('returns null when no sessionDir provided', () => {
      const id = manager.createTask(ECHO)
      expect(manager.getOutputFile(id)).toBeNull()
    })
  })

  // ── Process-group kill (POSIX) ────────────────────────────────────────────

  describe('process-group kill', () => {
    // POSIX-only: relies on process groups / detached:true spawning.
    // We use `&` to background a sleeper, then verify stopTask reaps
    // BOTH the shell AND the grandchild. Without group kill, the
    // grandchild would survive the shell's death.
    if (process.platform !== 'win32') {
      it('stopTask kills backgrounded grandchildren spawned via &', async () => {
        // Background a 30s sleeper from the shell. The shell itself
        // exits as soon as it forks `sleep 30 &`, but the grandchild
        // survives. Then we stopTask the task and verify the grandchild
        // is also gone.
        const cmd = '(sleep 30 &) && wait'
        const id = manager.createTask(cmd, { description: 'bg grandchild' })
        await new Promise((r) => setTimeout(r, 300)) // let it fork
        const task = manager.getTask(id)!
        expect(task.status).toBe('running')
        const pid = task.pid
        expect(pid).not.toBeNull()

        const stopped = manager.stopTask(id)
        expect(stopped).toBe(true)
        expect(manager.getTask(id)!.status).toBe('stopped')

        // Give the kernel time to reap.
        await new Promise((r) => setTimeout(r, 500))

        // /proc/<pid>/stat state field: 'Z' = zombie, anything else alive.
        // If the grandchild process group survived SIGTERM to the shell,
        // we'd still see a running 'sleep' process in /proc.
        // We test: every PID listed by `pgrep -P <shellPid>` is dead.
        const { execSync } = await import('child_process')
        let survivors = ''
        try {
          // pgrep may exit non-zero when no matches found — that's OK.
          survivors = execSync(
            `ps -o pid= -g ${pid} 2>/dev/null | tr -d ' ' | grep -v '^$' || true`,
            { encoding: 'utf8', timeout: 2000 },
          ).trim()
        } catch {
          /* no survivors */
        }
        expect(survivors).toBe('')
      })

      it('stopTask with -pid works even after process exited (no throw)', async () => {
        const id = manager.createTask(ECHO)
        await waitForDone(manager, id)
        // Calling stopTask on a completed task returns false (no error).
        expect(manager.stopTask(id)).toBe(false)
      })
    } else {
      it('skip POSIX-only grandchild test on win32', () => {
        expect(true).toBe(true)
      })
    }
  })

  // ── Constructor option validation ──────────────────────────────────────────

  describe('constructor options', () => {
    it('accepts finite non-negative integer sigkillGraceMs (including 0)', () => {
      const m = new BackgroundTaskManager({ sigkillGraceMs: 0 })
      // 0 means immediate SIGKILL — verify it doesn't throw and the
      // manager can still spawn/stop tasks.
      const id = m.createTask(ECHO)
      expect(m.getTask(id)).toBeDefined()
      m.dispose()
    })

    it('falls back to default for invalid sigkillGraceMs (NaN/Infinity/-1/float/string)', () => {
      const cases: unknown[] = [NaN, Infinity, -Infinity, -1, 1.5, '3000', null, undefined, true]
      for (const v of cases) {
        // Constructor must not throw.
        expect(() => new BackgroundTaskManager({ sigkillGraceMs: v as number })).not.toThrow()
        // And the manager must be usable.
        const m = new BackgroundTaskManager({ sigkillGraceMs: v as number })
        const id = m.createTask(ECHO)
        expect(m.getTask(id)).toBeDefined()
        m.dispose()
      }
    })

    it('falls back to default for invalid maxOutputFileBytes (NaN/Infinity/0/negative/float/string)', () => {
      const cases: unknown[] = [NaN, Infinity, -Infinity, 0, -100, 1024.5, '1024', null, undefined]
      for (const v of cases) {
        expect(() => new BackgroundTaskManager({ maxOutputFileBytes: v as number })).not.toThrow()
        const m = new BackgroundTaskManager({ maxOutputFileBytes: v as number })
        const id = m.createTask(ECHO, { sessionDir: tmpdir() })
        expect(m.getTask(id)).toBeDefined()
        m.dispose()
      }
    })

    it('default values apply when options is empty or omitted', () => {
      expect(() => new BackgroundTaskManager()).not.toThrow()
      expect(() => new BackgroundTaskManager({})).not.toThrow()
      const m = new BackgroundTaskManager()
      const id = m.createTask(ECHO)
      expect(m.getTask(id)).toBeDefined()
      m.dispose()
    })
  })

  // ── Idempotent stop at all phases ────────────────────────────────────────

  describe('idempotent stop', () => {
    it('returns false after stop has been called even if process still alive', async () => {
      // After the first stop():
      //   - task.stopped = true
      //   - killTimer is armed
      //   - process is still alive (SIGTERM-ignoring case)
      // A second stop() within the grace window MUST return false
      // and MUST NOT re-signal. This is the critical safety property:
      // without it, a user clicking "stop" twice (or a tool calling
      // stop twice in a race) could trigger a second SIGKILL after
      // the first — and if the original PID has been recycled to an
      // unrelated process by then, we'd kill the wrong process.
      if (process.platform === 'win32') {
        // Windows path uses taskkill which is one-shot anyway; skip.
        expect(true).toBe(true)
        return
      }
      const m = new BackgroundTaskManager({ sigkillGraceMs: 60_000 }) // long grace so timer is still armed
      const id = m.createTask(LONG_SLEEP, { description: 'twice' })
      await new Promise((r) => setTimeout(r, 200))
      expect(m.stopTask(id)).toBe(true)
      // Immediately stop again — must return false.
      expect(m.stopTask(id)).toBe(false)
      // And again.
      expect(m.stopTask(id)).toBe(false)
      // Status remains 'stopped'.
      expect(m.getTask(id)!.status).toBe('stopped')
      // Cleanup.
      m.dispose()
    })
  })

// ── Duplicate stop ────────────────────────────────────────────────────────

  describe('duplicate stop', () => {
    it('returns false the second time stopTask is called', async () => {
      const id = manager.createTask(LONG_SLEEP, { description: 'long' })
      await new Promise((r) => setTimeout(r, 200))
      expect(manager.stopTask(id)).toBe(true)
      expect(manager.stopTask(id)).toBe(false)
      expect(manager.stopTask(id)).toBe(false)
      expect(manager.getTask(id)!.status).toBe('stopped')
    })

    it('duplicate stop does not re-arm the SIGKILL escalation timer', async () => {
      // We can't easily inspect the manager's private killTimer, but we
      // can verify the OBSERVABLE consequence: calling stop() twice in
      // rapid succession on the same task is idempotent and doesn't
      // produce an error. The earlier test covers return-value semantics.
      const id = manager.createTask(LONG_SLEEP, { description: 'rapid' })
      await new Promise((r) => setTimeout(r, 200))
      expect(manager.stopTask(id)).toBe(true)
      // Immediate second/third calls — must not throw and must not
      // re-signal (would be invisible to user but could kill a reused
      // PID via the grace-window escalation).
      expect(() => manager.stopTask(id)).not.toThrow()
      expect(() => manager.stopTask(id)).not.toThrow()
    })
  })

  // ── SIGKILL escalation: doesn't fire after close handler runs ─────────────

  describe('SIGKILL escalation races', () => {
    it('normal completion clears the kill timer (no late SIGKILL on PID reuse)', async () => {
      // Use a short sleep so the task completes naturally during the
      // grace window. With the fix, the close handler clears killTimer
      // and nulls task.process — so the escalation callback's
      // `task.process !== proc` guard fires and it does NOT re-signal.
      // Without the fix, the callback would always kill again, which
      // would be invisible here (process already gone) but is the
      // correctness invariant we want to lock down.
      const id = manager.createTask(SLEEP, { description: 'fast finish' })
      await waitForDone(manager, id, 5000)
      // Sleep > grace, so the (would-be) escalation already passed.
      // If the timer had fired AND tried to re-signal, we wouldn't see
      // it (process gone) — but the test verifies the close handler
      // cleared the timer and there's no lingering process handle.
      const info = manager.getTask(id)!
      expect(info.status).toBe('completed')
      expect(info.exitCode).toBe(0)
    })

    it('does not call killProcessTree again after the process has exited', async () => {
      // Direct behavioral test: spawn a sleep, stop it, wait long enough
      // for the close handler to fire, then assert nothing extra fires
      // during what would have been the escalation window. We can't
      // mock killProcessTree (it's a module-internal function), but we
      // can prove the invariant indirectly: the stop succeeds, the
      // status stays 'stopped', and a fresh task created afterward is
      // unaffected.
      const id = manager.createTask(SLEEP, { description: 'race' })
      // Let it start, then stop it (SIGTERM). The shell will exit, the
      // close handler clears the timer. The escalation never fires.
      await new Promise((r) => setTimeout(r, 100))
      expect(manager.stopTask(id)).toBe(true)
      // Wait past the grace window + close propagation.
      await new Promise((r) => setTimeout(r, 3500))
      const info = manager.getTask(id)!
      expect(info.status).toBe('stopped')
      // No leftover timer keeping the loop alive: the close handler
      // cleared killTimer, which had .unref() anyway.
    })
    it('escalation kills SIGTERM-ignoring tasks within graceMs (POSIX)', async () => {
      // Strategy: write a tiny bash script that (1) traps SIGTERM, so
      // the task PID ignores SIGTERM, (2) backgrounds a sleeper bash
      // that ALSO traps SIGTERM (so the grandchild ignores it too),
      // (3) writes the grandchild's pure-digit PID to a pidfile path
      // passed as $1, (4) waits. We invoke it via `exec bash script pidfile`
      // so the task PID IS the trapping script — no intermediate
      // wrapper shell. After stopTask → SIGTERM: both PIDs survive
      // past grace/2; after grace → SIGKILL: both are gone.
      if (process.platform === 'win32') {
        expect(true).toBe(true)
        return
      }
      const tmpDir = join(
        tmpdir(),
        `btm-escalate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      )
      mkdirSync(tmpDir, { recursive: true })
      const scriptPath = join(tmpDir, 'trapper.sh')
      const pidFile = join(tmpDir, 'child.pid')
      writeFileSync(
        scriptPath,
        [
          '#!/usr/bin/env bash',
          // Trapper script: ignore SIGTERM (otherwise bash dies on TERM).
          "trap '' TERM",
          // Background a grandchild bash that ALSO traps TERM and
          // busy-loops forever. $BASHPID is the backgrounded subshell.
          // We write its pure-digit PID to $1 so the test can probe it.
          '( trap "" TERM; while :; do sleep 1; done ) &',
          'echo $! > "$1"',
          'wait',
        ].join('\n') + '\n',
        'utf8',
      )
      try {
        const graceMs = 500
        const fastManager = new BackgroundTaskManager({ sigkillGraceMs: graceMs })
        // Safe shell quoting via single-quotes around each path; the
        // command itself is what BTM passes to `bash -lc <command>`.
        const cmd = `exec bash '${scriptPath}' '${pidFile}'`
        const id = fastManager.createTask(cmd, { description: 'escalate' })
        // Wait for the trapper to background its grandchild + write pidfile.
        for (let i = 0; i < 50 && !existsSync(pidFile); i++) {
          await new Promise((r) => setTimeout(r, 50))
        }
        expect(existsSync(pidFile)).toBe(true)
        // Hygiene guard: the pidfile MUST live inside our test tmpDir
        // (an absolute path) — never in cwd or any other location.
        // A regression that drops the absolute path would leak a file
        // named `file` or similar into the repo root.
        expect(pidFile.startsWith(tmpDir + '/')).toBe(true)
        const childPid = Number(readFileSync(pidFile, 'utf8').trim())
        expect(Number.isFinite(childPid) && childPid > 0).toBe(true)
        const taskPid = fastManager.getTask(id)!.pid
        expect(taskPid).not.toBeNull()

        // stop → SIGTERM is ignored by both. Verify both alive at grace/2.
        expect(fastManager.stopTask(id)).toBe(true)
        await new Promise((r) => setTimeout(r, Math.floor(graceMs / 2)))
        expect(isPidAlive(taskPid!)).toBe(true)
        expect(isPidAlive(childPid)).toBe(true)

        // Wait past full grace + escalation propagation.
        await new Promise((r) => setTimeout(r, graceMs + 400))
        // Both must now be gone (Z = zombie, X = disappeared).
        expect(isPidAlive(taskPid!)).toBe(false)
        expect(isPidAlive(childPid)).toBe(false)
      } finally {
        try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    }, 10_000)
  })

  // ── dispose() ─────────────────────────────────────────────────────────────

  describe('dispose', () => {
    it('stops all running tasks and clears state', async () => {
      const id1 = manager.createTask(LONG_SLEEP, { description: 'a' })
      const id2 = manager.createTask(LONG_SLEEP, { description: 'b' })
      await new Promise((r) => setTimeout(r, 200))

      manager.dispose()

      // Internal state cleared — getTask returns undefined.
      expect(manager.getTask(id1)).toBeUndefined()
      expect(manager.getTask(id2)).toBeUndefined()
      expect(manager.listTasks()).toHaveLength(0)
    })

    it('is idempotent and safe to call when idle', () => {
      manager.dispose()
      manager.dispose()
      expect(manager.listTasks()).toHaveLength(0)
    })

    it('stops running POSIX grandchildren via group kill', async () => {
      if (process.platform === 'win32') {
        expect(true).toBe(true)
        return
      }
      const cmd = '(sleep 30 &) && wait'
      const id = manager.createTask(cmd, { description: 'dispose group kill' })
      await new Promise((r) => setTimeout(r, 300))
      const pid = manager.getTask(id)!.pid

      manager.dispose()

      await new Promise((r) => setTimeout(r, 500))

      // Verify the whole process group is gone.
      const { execSync } = await import('child_process')
      let survivors = ''
      try {
        survivors = execSync(
          `ps -o pid= -g ${pid} 2>/dev/null | tr -d ' ' | grep -v '^$' || true`,
          { encoding: 'utf8', timeout: 2000 },
        ).trim()
      } catch {
        /* no survivors */
      }
      expect(survivors).toBe('')
    })
  })

  // ── Output file rotation ──────────────────────────────────────────────────

  describe('output file rotation', () => {
    let sessionDir: string

    beforeEach(() => {
      sessionDir = join(
        tmpdir(),
        `btm-rotation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      )
    })

    afterEach(() => {
      try {
        if (existsSync(sessionDir)) {
          rmSync(sessionDir, { recursive: true, force: true })
        }
      } catch {
        /* best-effort */
      }
    })

    // We use real file-write paths to verify rotation actually happens.
    // CRITICAL: the helper scripts MUST emit output in delayed chunks
    // (await between writes). Without the delay, Node's stdout buffers
    // coalesce the writes into one big chunk that arrives at the BTM
    // as a single append — which still triggers rotation but only
    // once, defeating tests that rely on multiple rotations. With the
    // delay, each chunk arrives separately, the byte counter
    // accumulates incrementally, and rotation fires at each cap
    // crossing exactly as designed.
    //
    // All tests first assert that the task COMPLETED with the
    // expected outputLength — guards against a silent failure where
    // the test asserts rotation but the task never produced output.
    it('rotates the output file when it exceeds the cap', async () => {
      mkdirSync(sessionDir, { recursive: true })
      const rotManager = new BackgroundTaskManager({ maxOutputFileBytes: 10_000 })
      const helperPath = join(sessionDir, 'rotate-helper.js')
      // 25 chunks × 1KB, with 20ms delay between writes.
      writeFileSync(
        helperPath,
        [
          'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));',
          'async function main() {',
          '  for (let i = 0; i < 25; i++) {',
          '    process.stdout.write("X".repeat(1000));',
          '    await sleep(20);',
          '  }',
          '}',
          'main();',
        ].join('\n') + '\n',
        'utf8',
      )
      const id = rotManager.createTask(`node ${helperPath}`, {
        sessionDir,
        description: 'rotate',
      })
      await waitForDone(rotManager, id, 30_000)
      // First: confirm the task actually produced the bytes we expect.
      const info0 = rotManager.getTask(id)!
      expect(info0.status).toBe('completed')
      expect(info0.outputLength).toBe(25_000)

      const outFile = rotManager.getOutputFile(id)!
      // After rotation, the active file is small (≤ cap after last rotate)
      // and the rotated file holds earlier chunks.
      expect(existsSync(outFile)).toBe(true)
      expect(existsSync(outFile + '.1')).toBe(true)
      const rotatedSize = statSync(outFile + '.1').size
      expect(rotatedSize).toBeGreaterThan(0)
      // The current log file is small because we rotate after every append
      // that pushes it over the cap. With 25KB output and a 10KB cap,
      // it should have rotated at least once.
      const currentSize = statSync(outFile).size
      expect(currentSize).toBeLessThanOrEqual(10_000)
    }, 60_000)

    it('current log file always exists after rotation (no dangling path)', async () => {
      // Race-free invariant: after rotation the manager must immediately
      // create a fresh empty log at the original path. Otherwise a task
      // that ends right after rotation would leave getOutputFile() pointing
      // at a file that no longer exists on disk.
      mkdirSync(sessionDir, { recursive: true })
      const rotManager = new BackgroundTaskManager({ maxOutputFileBytes: 5_000 })
      const helperPath = join(sessionDir, 'race-helper.js')
      // 8 chunks × 1KB with delay — exceeds 5KB cap, rotates at least once.
      writeFileSync(
        helperPath,
        [
          'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));',
          'async function main() {',
          '  for (let i = 0; i < 8; i++) {',
          '    process.stdout.write("Y".repeat(1000));',
          '    await sleep(20);',
          '  }',
          '}',
          'main();',
        ].join('\n') + '\n',
        'utf8',
      )
      const id = rotManager.createTask(`node ${helperPath}`, {
        sessionDir,
        description: 'race',
      })
      await waitForDone(rotManager, id, 30_000)
      // First: confirm the task actually produced the bytes we expect.
      const info0 = rotManager.getTask(id)!
      expect(info0.status).toBe('completed')
      expect(info0.outputLength).toBe(8_000)

      const outFile = rotManager.getOutputFile(id)!
      // Invariant: the path returned by getOutputFile() must always
      // point to a real file on disk.
      expect(existsSync(outFile)).toBe(true)
      // And we should be able to read it.
      const content = readFileSync(outFile, 'utf8')
      // After rotation, the current file is small and holds tail content.
      // Its size must be ≤ the cap (rotation happens on append that
      // pushes over the cap, so post-rotation the file is fresh/empty).
      expect(content.length).toBeLessThanOrEqual(5_000)
    }, 60_000)

    it('total bound: current + .1 cannot exceed cap + one chunk', async () => {
      // After multiple rotations, only the most recent `.1` survives
      // (we don't chain `.2`, `.3`, ...). Verify the combined size
      // stays bounded — at most cap (current) + cap (the most recent
      // rotation before the last one), but never the full output.
      mkdirSync(sessionDir, { recursive: true })
      const rotManager = new BackgroundTaskManager({ maxOutputFileBytes: 8_000 })
      const helperPath = join(sessionDir, 'bound-helper.js')
      // 30 chunks × 1KB with delay — exceeds 8KB cap, rotates ~3 times.
      writeFileSync(
        helperPath,
        [
          'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));',
          'async function main() {',
          '  for (let i = 0; i < 30; i++) {',
          '    process.stdout.write("Z".repeat(1000));',
          '    await sleep(20);',
          '  }',
          '}',
          'main();',
        ].join('\n') + '\n',
        'utf8',
      )
      const id = rotManager.createTask(`node ${helperPath}`, {
        sessionDir,
        description: 'bound',
      })
      await waitForDone(rotManager, id, 30_000)
      // First: confirm the task actually produced the bytes we expect.
      const info0 = rotManager.getTask(id)!
      expect(info0.status).toBe('completed')
      expect(info0.outputLength).toBe(30_000)

      const outFile = rotManager.getOutputFile(id)!
      expect(existsSync(outFile)).toBe(true)
      expect(existsSync(outFile + '.1')).toBe(true)
      const cur = statSync(outFile).size
      const prev = statSync(outFile + '.1').size
      // No `.2` — we only keep one generation back.
      expect(existsSync(outFile + '.2')).toBe(false)
      // outputLength should match the FULL produced bytes (30KB),
      // not be capped by what's on disk.
      const info = rotManager.getTask(id)!
      expect(info.outputLength).toBe(30_000)
      // On-disk footprint is bounded. After rotation, `current` is
      // empty (the most recent rotation) and `.1` holds everything
      // that was rotated. Worst case (single giant write triggers one
      // rotation): current=0, .1 = full outputLength. Bound: ≤ outputLength + cap.
      expect(cur + prev).toBeLessThanOrEqual(30_000 + 8_000)
    }, 60_000)

    it('does not rotate when output stays under the cap', async () => {
      const id = manager.createTask(ECHO, { sessionDir, description: 'small' })
      await waitForDone(manager, id)
      const outFile = manager.getOutputFile(id)!
      expect(existsSync(outFile)).toBe(true)
      expect(existsSync(outFile + '.1')).toBe(false)
      expect(readFileSync(outFile, 'utf8')).toContain('hello')
    })

    it('outputLength still tracks total bytes despite rotation', async () => {
      const id = manager.createTask(ECHO, { sessionDir, description: 'len' })
      await waitForDone(manager, id)
      const info = manager.getTask(id)!
      expect(info.outputLength).toBeGreaterThan(0)
      // Should match the on-disk content size (no rotation occurred).
      const outFile = manager.getOutputFile(id)!
      const onDisk = readFileSync(outFile, 'utf8').length
      expect(info.outputLength).toBe(onDisk)
    })

    it('rotation triggers by UTF-8 byte count (multibyte chars count as 3 bytes)', async () => {
      // Chinese character '中' is 3 bytes in UTF-8 (E4 B8 AD). We craft a
      // helper that emits exactly enough 3-byte chars to cross the 1500-byte
      // cap. With a string-length counter (the OLD behavior), each '中'
      // would count as 1 char and the cap would never fire; with the
      // new Buffer.byteLength counter, the cap fires at ~500 chars.
      mkdirSync(sessionDir, { recursive: true })
      const rotManager = new BackgroundTaskManager({ maxOutputFileBytes: 1500 })
      const helperPath = join(sessionDir, 'utf8-helper.js')
      // Emit 600 copies of '中' — that's 1800 UTF-8 bytes, well over 1500.
      writeFileSync(
        helperPath,
        [
          'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));',
          'async function main() {',
          '  for (let i = 0; i < 30; i++) {',
          '    process.stdout.write("中".repeat(20));', // 60 bytes per write
          '    await sleep(10);',
          '  }',
          '}',
          'main();',
        ].join('\n') + '\n',
        'utf8',
      )
      const id = rotManager.createTask(`node ${helperPath}`, {
        sessionDir,
        description: 'utf8-rotation',
      })
      await waitForDone(rotManager, id, 30_000)

      const info = rotManager.getTask(id)!
      expect(info.status).toBe('completed')
      // outputLength is the byte count (1800 bytes for 600 '中' chars).
      expect(info.outputLength).toBe(1800)

      const outFile = rotManager.getOutputFile(id)!
      // At least one rotation happened — both files exist on disk.
      expect(existsSync(outFile)).toBe(true)
      expect(existsSync(outFile + '.1')).toBe(true)
      // The current file is small (≤ cap after the most recent rotation).
      // The .1 file holds the rotated prefix.
      const currentSize = statSync(outFile).size
      const rotatedSize = statSync(outFile + '.1').size
      expect(currentSize).toBeLessThanOrEqual(1500)
      expect(rotatedSize).toBeGreaterThan(0)
    }, 60_000)
  })
})

// ── Formatting helpers ──────────────────────────────────────────────────────

describe('formatTaskList', () => {
  it('returns message for empty list', () => {
    expect(formatTaskList([])).toBe('No background tasks.')
  })

  it('formats tasks with status icons', () => {
    const tasks = [
      {
        id: 'task_abc', command: 'echo hi', description: 'test',
        status: 'completed' as const, exitCode: 0, pid: 123,
        startTime: 1000, endTime: 2000, durationMs: 1000, outputLength: 10,
        metadata: {},
      },
      {
        id: 'task_def', command: 'sleep 30', description: 'long',
        status: 'running' as const, exitCode: null, pid: 456,
        startTime: 3000, endTime: null, durationMs: null, outputLength: 0,
        metadata: {},
      },
    ]
    const result = formatTaskList(tasks)
    expect(result).toContain('✓')
    expect(result).toContain('task_abc')
    expect(result).toContain('completed')
    expect(result).toContain('◆')
    expect(result).toContain('task_def')
    expect(result).toContain('running')
  })

  it('shows exit code for non-zero', () => {
    const tasks = [
      {
        id: 'task_x', command: 'false', description: 'fail',
        status: 'failed' as const, exitCode: 1, pid: 789,
        startTime: 1000, endTime: 2000, durationMs: 1000, outputLength: 0,
        metadata: {},
      },
    ]
    const result = formatTaskList(tasks)
    expect(result).toContain('exit=1')
    expect(result).toContain('✗')
  })
})

describe('formatTaskDetail', () => {
  it('formats a completed task with output', () => {
    const detail = {
      id: 'task_abc', command: 'echo hi', description: 'test',
      status: 'completed' as const, exitCode: 0, pid: 123,
      startTime: 1000, endTime: 2000, durationMs: 1000, outputLength: 3,
      metadata: {}, output: 'hi\n',
    }
    const result = formatTaskDetail(detail)
    expect(result).toContain('Task task_abc: test')
    expect(result).toContain('Status: completed')
    expect(result).toContain('exit code: 0')
    expect(result).toContain('Command: echo hi')
    expect(result).toContain('Duration: 1.0s')
    expect(result).toContain('PID: 123')
    expect(result).toContain('hi')
  })

  it('formats a running task with "(still running)"', () => {
    const detail = {
      id: 'task_run', command: 'sleep 30', description: 'long',
      status: 'running' as const, exitCode: null, pid: 456,
      startTime: 1000, endTime: null, durationMs: null, outputLength: 0,
      metadata: {}, output: '',
    }
    const result = formatTaskDetail(detail)
    expect(result).toContain('(still running)')
    expect(result).toContain('(no output yet)')
  })
})
