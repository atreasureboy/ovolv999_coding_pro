/**
 * CommandRunner (six_goal Phase 2) — the single abstraction for running
 * external commands. Business logic must NOT call exec/execSync/spawn
 * directly; it goes through runCommand(), which uniformly provides:
 *
 *   - timeout + AbortSignal cancellation with process-TREE kill
 *     (detached spawn + `kill(-pid)` reaches shell + all children)
 *   - stdout/stderr byte limits with truncation flag
 *   - cwd normalisation
 *   - environment-variable pass-through
 *   - shell:false by default (safe arg-array form); shell:true opt-in
 *     for trusted string commands (e.g. project `package.json` scripts)
 *   - a structured CommandResult (exit/signal/stdout/stderr/timedOut/
 *     cancelled/duration/truncated) so callers never parse text to
 *     decide success
 *
 * Today the underlying transport is node's spawn; that is the ONE
 * legitimate direct-spawn site. Sites still using exec/execSync are
 * listed in docs/V0_2_RUNTIME_INTEGRITY.md §5 (allowlist) and migrate
 * here incrementally — runVerification (agent.ts) is the first.
 */

import { spawn, spawnSync } from 'child_process'

export interface CommandSpec {
  executable: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
  stdin?: string
  outputLimitBytes?: number
  /** Default false (arg-array, no shell). Set true for trusted string commands. */
  shell?: boolean
}

export interface CommandResult {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  timedOut: boolean
  cancelled: boolean
  durationMs: number
  truncated: boolean
}

export const DEFAULT_OUTPUT_LIMIT_BYTES = 256 * 1024

/**
 * Run a command per `spec`. Never throws on non-zero exit — returns a
 * CommandResult with exitCode (null if killed by signal). Throws only
 * on spawn failure (ENOENT etc.) so callers can distinguish "command
 * didn't run" from "command ran and failed".
 */
export async function runCommand(spec: CommandSpec): Promise<CommandResult> {
  const {
    executable, args, cwd, env, timeoutMs, signal, stdin,
    outputLimitBytes = DEFAULT_OUTPUT_LIMIT_BYTES, shell = false,
  } = spec
  const start = Date.now()

  // Pre-abort: if the signal is already aborted, refuse to spawn.
  if (signal?.aborted) {
    return zeroResult({ cancelled: true, durationMs: Date.now() - start })
  }

  const child = spawn(executable, args, {
    cwd,
    env: env ?? process.env,
    detached: true, // own process group → kill(-pid) reaches the tree
    stdio: [stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    shell,
  })

  let timedOut = false
  let cancelled = false
  let stdoutBuf = Buffer.alloc(0)
  let stderrBuf = Buffer.alloc(0)
  let truncated = false
  const append = (which: 'stdout' | 'stderr', data: Buffer): void => {
    const cur = which === 'stdout' ? stdoutBuf : stderrBuf
    if (cur.length >= outputLimitBytes) {
      truncated = true
      return
    }
    const room = outputLimitBytes - cur.length
    const next = data.length > room ? (truncated = true, data.subarray(0, room)) : data
    const merged = Buffer.concat([cur, next])
    if (which === 'stdout') stdoutBuf = merged
    else stderrBuf = merged
  }

  return new Promise<CommandResult>((resolve) => {
    // ENOENT etc. — spawn itself failed (command not found).
    child.on('error', (err) => {
      cleanup()
      // Surface as a non-zero result with the error in stderr rather than
      // throwing: callers handle "command failed" uniformly.
      resolve({
        exitCode: -1,
        signal: null,
        stdout: stdoutBuf.toString('utf8'),
        stderr: (stderrBuf.toString('utf8') + (stderrBuf.length ? '\n' : '') + err.message),
        timedOut: false,
        cancelled: false,
        durationMs: Date.now() - start,
        truncated,
      })
    })

    child.stdout?.on('data', (d: Buffer) => append('stdout', d))
    child.stderr?.on('data', (d: Buffer) => append('stderr', d))

    if (stdin !== undefined && child.stdin) {
      child.stdin.end(stdin)
    }

    let timer: NodeJS.Timeout | undefined
    const onTimeout = (): void => {
      timedOut = true
      killTree()
    }
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(onTimeout, timeoutMs)
    }

    const onAbort = (): void => {
      cancelled = true
      killTree()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    function killTree(): void {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        // best-effort — pgid may already be gone.
      }
    }
    function cleanup(): void {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }

    child.on('close', (code, sig) => {
      cleanup()
      resolve({
        exitCode: code,
        signal: sig,
        stdout: stdoutBuf.toString('utf8'),
        stderr: stderrBuf.toString('utf8'),
        timedOut,
        cancelled,
        durationMs: Date.now() - start,
        truncated,
      })
    })
  })
}

function zeroResult(p: { cancelled?: boolean; timedOut?: boolean; durationMs: number }): CommandResult {
  return {
    exitCode: null, signal: null, stdout: '', stderr: '',
    cancelled: !!p.cancelled, timedOut: !!p.timedOut,
    durationMs: p.durationMs, truncated: false,
  }
}

/**
 * Synchronous variant for legacy sync call sites (e.g. runVerification)
 * that cannot be made async without rippling signature changes. Uses
 * spawnSync so it blocks the event loop — prefer the async runCommand()
 * for new code. Provides the SAME structured-result contract (timeout,
 * bounded output, exit/signal) minus AbortSignal/streaming (which need
 * an event loop). Output is truncated to outputLimitBytes per stream.
 */
export function runCommandSync(spec: CommandSpec): CommandResult {
  const {
    executable, args, cwd, env, timeoutMs,
    outputLimitBytes = DEFAULT_OUTPUT_LIMIT_BYTES, shell = false,
  } = spec
  const start = Date.now()
  const r = spawnSync(executable, args, {
    cwd,
    env: env ?? process.env,
    shell,
    timeout: timeoutMs,
    encoding: 'utf8',
    maxBuffer: outputLimitBytes,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const timedOut = r.signal === 'SIGTERM' && !!timeoutMs // spawnSync sends SIGTERM on timeout
  const stdoutRaw = r.stdout ?? ''
  const stderrRaw = r.stderr ?? ''
  const truncate = (s: string): string => s.length > outputLimitBytes ? s.slice(0, outputLimitBytes) : s
  const stdout = truncate(stdoutRaw)
  const stderr = truncate(stderrRaw)
  return {
    exitCode: r.status,
    signal: r.signal,
    stdout,
    stderr,
    timedOut,
    cancelled: false,
    durationMs: Date.now() - start,
    truncated: stdout.length < stdoutRaw.length || stderr.length < stderrRaw.length,
  }
}
