/**
 * Loop Engine — built-in autonomous loop protocol (loop-kit integration).
 *
 * Implements the WAKE → SCAN → PLAN → DO → REVIEW → CHECK → ACT cycle
 * from the loop-kit LOOP.md protocol, but as a native ovolv999 capability
 * instead of external shell scripts calling `claude -p`.
 *
 * Usage: `ovolv999 --loop` or `ovolv999 --loop --goal "fix all type errors"`
 *
 * The loop engine:
 * 1. Reads .loop/GOAL.md, .loop/ACCEPTANCE.md, .loop/STATE.md
 * 2. Constructs a prompt for the engine
 * 3. Runs a turn (fresh context each iteration, STATE.md is the memory)
 * 4. After each turn: runs acceptance checks
 * 5. If all pass + quality gates green → DONE
 * 6. Otherwise → next iteration (up to MAX_ITERS)
 */

import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'fs'
import { join } from 'path'
import { hostname } from 'os'
import { runCommandSync } from './commandRunner.js'
import { LoopLeaseManager, CheckpointManager, hashContract, type HeartbeatInfo } from './loopSupervisor.js'
import type { ExecutionEngine } from './engine.js'
import type { Renderer } from '../ui/renderer.js'
import { isTerminalRunStatus } from './executionRun.js'

const MAX_ITERS = 12

interface AcceptanceResult {
  id: string
  command: string
  passed: boolean
  output: string
}

interface LoopConfig {
  cwd: string
  loopDir: string
  maxIters: number
}

function tryRead(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function parseAcceptance(content: string): Array<{ id: string; command: string }> {
  const items: Array<{ id: string; command: string }> = []
  const lines = content.split('\n')
  for (const line of lines) {
    const match = line.match(/^\s*-\s*\[.\]\s*(A\d+):\s*.*?`([^`]+)`/)
    if (match) {
      items.push({ id: match[1], command: match[2] })
    }
  }
  return items
}

/**
 * v0.3.4 (mimo_goal §Phase 8): configurable timeouts per command type.
 * Defaults are generous — a full test suite can legitimately take 30 min.
 */
const GATE_TIMEOUTS: Record<string, number> = {
  typecheck: 5 * 60_000,    // 5 min
  lint: 5 * 60_000,          // 5 min
  test: 15 * 60_000,         // 15 min
  'full test': 30 * 60_000,  // 30 min
  eval: 30 * 60_000,         // 30 min
  build: 15 * 60_000,        // 15 min
  default: 5 * 60_000,       // 5 min (NOT 60s)
}

function getTimeoutMs(gateName: string): number {
  return GATE_TIMEOUTS[gateName.toLowerCase()] ?? GATE_TIMEOUTS.default
}

function runAcceptance(command: string, cwd: string, timeoutMs?: number): { passed: boolean; output: string } {
  // v0.3.4: timeout is configurable per gate type, default 5 min (not 60s)
  const res = runCommandSync({
    executable: command,
    args: [],
    cwd,
    shell: true,
    timeoutMs: timeoutMs ?? GATE_TIMEOUTS.default,
  })
  const output = ((res.stdout ?? '') + (res.stderr ?? '')).trim().slice(0, 500)
  if (res.exitCode === 0 && !res.timedOut && !res.cancelled) {
    return { passed: true, output }
  }
  return { passed: false, output: output || (res.timedOut ? 'timed out' : 'failed') }
}

function runQualityGates(cwd: string): { passed: boolean; results: string[] } {
  const results: string[] = []
  let allPassed = true

  const commands = [
    { name: 'typecheck', cmd: 'npx tsc --noEmit 2>&1' },
    { name: 'lint', cmd: 'npx eslint src/ bin/ tests/ 2>&1' },
  ]

  for (const { name, cmd } of commands) {
    const result = runAcceptance(cmd, cwd, getTimeoutMs(name))
    if (result.passed) {
      results.push(`✓ ${name}`)
    } else {
      results.push(`✗ ${name}: ${result.output.slice(0, 200)}`)
      allPassed = false
    }
  }

  return { passed: allPassed, results }
}

/** Run the autonomous loop */
export async function runLoop(
  engine: ExecutionEngine,
  renderer: Renderer,
  config: LoopConfig,
): Promise<void> {
  const { cwd, loopDir } = config
  const maxIters = config.maxIters || MAX_ITERS

  // Ensure .loop/ exists
  if (!existsSync(loopDir)) {
    renderer.error(`Loop dir not found: ${loopDir}`)
    renderer.info('Create .loop/ with LOOP.md, GOAL.md, ACCEPTANCE.md first.')
    return
  }

  // Read goal early — needed for taskId before lease acquisition
  const goal = tryRead(join(loopDir, 'GOAL.md'))
  const acceptanceRaw = tryRead(join(loopDir, 'ACCEPTANCE.md'))

  if (!goal) {
    renderer.error('GOAL.md not found or empty')
    return
  }

  // v0.3.4 (mimo_goal §Phase 4-6): Durable lease + heartbeat + checkpoint.
  const taskId = goal.split('\n').find((l) => l.trim())?.slice(0, 60) || 'loop-task'
  const leaseMgr = new LoopLeaseManager(loopDir)
  const checkpointMgr = new CheckpointManager(loopDir)
  try {
    leaseMgr.acquire(taskId, cwd)
  } catch {
    const taken = leaseMgr.tryTakeover(taskId, cwd)
    if (!taken) {
      renderer.error('Another loop is running and its lease is still fresh. Remove loop.lock if stale.')
      return
    }
    renderer.info('Stale lease taken over.')
  }
  let loopIteration = 1
  let consecutiveProviderFailures = 0

  // Try restore from checkpoint
  const restoredCp = checkpointMgr.load()
  if (restoredCp) {
    loopIteration = restoredCp.iteration + 1
    consecutiveProviderFailures = restoredCp.consecutiveProviderFailures
    renderer.info(`Resumed from checkpoint: iteration ${loopIteration}, ${consecutiveProviderFailures} prior provider failures.`)
  }

  // Start heartbeat
  leaseMgr.startHeartbeat((): HeartbeatInfo => ({
    iteration: loopIteration,
    phase: 'executing',
    lastProgressAt: new Date().toISOString(),
    workerCount: 0,
    circuitStatus: consecutiveProviderFailures >= 5 ? 'open' : 'closed',
    checkpointSequence: restoredCp?.sequence ?? 0,
  }))

  const acceptanceItems = parseAcceptance(acceptanceRaw)

  renderer.info(`Loop mode: ${maxIters} max iterations · ${acceptanceItems.length} acceptance checks`)

  // ── ExecutionRun tracking (GAP-C: kind='loop') ──
  // When the engine exposes a registry (i.e. `executionRunLogDir`
  // was set), the entire loop is wrapped in a `kind='loop'` run
  // whose goal is the GOAL.md headline. Per-iteration turns are
  // recorded as child `kind='turn'` runs via the coordinator wiring.
  const registry = engine.getRunRegistry?.()
  // Start in 'running' directly — the loop IS the worker. We never
  // queue; runLoop begins executing synchronously on entry. (Going
  // through queued → preparing → running would be ceremony for no
  // observable benefit since this is the top-level orchestrator.)
  const loopRunId = registry
    ? registry.create({
        kind: 'loop',
        goal: goal.split('\n').find((l) => l.trim())?.slice(0, 200) || 'autonomous loop',
        workspace: { cwd },
        status: 'running',
        phase: 'loop_start',
      }).runId
    : undefined
  const finishLoopRun = (status: 'succeeded' | 'failed' | 'cancelled', err?: string) => {
    // v0.3.4: save final checkpoint + stop heartbeat + release lease
    try {
      checkpointMgr.save({
        schemaVersion: 1, sequence: Date.now(), taskId, branch: 'main', worktree: cwd,
        iteration: loopIteration, phase: status, goalHash: hashContract(goal),
        acceptanceHash: hashContract(tryRead(join(loopDir, 'ACCEPTANCE.md'))),
        changedFiles: [], consecutiveNoProgress: 0,
        consecutiveProviderFailures, consecutiveCommandFailures: 0,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      })
    } catch { /* best-effort */ }
    leaseMgr.stopHeartbeat()
    leaseMgr.release()
    if (!loopRunId || !registry) return
    try {
      const r = registry.get(loopRunId)
      if (r && !isTerminalRunStatus(r.status)) {
        registry.transition(loopRunId, status, { phase: 'completed', error: err })
      }
    } catch { /* best-effort */ }
  }

  for (let iter = 1; iter <= maxIters; iter++) {
    // v0.3.3 (tha_goal §5.2): only trust DRIVER-written DONE.flag.
    // If a model wrote DONE.flag during a turn, rename it — the driver
    // must independently verify acceptance before completing.
    const donePath = join(loopDir, 'DONE.flag')
    if (existsSync(donePath)) {
      const content = tryRead(donePath)
      if (!content.includes('DRIVER_VERIFIED')) {
        // Model-written DONE — security event, rename and continue.
        try { renameSync(donePath, join(loopDir, 'DONE.flag.rejected')) } catch { /* best-effort */ }
        renderer.warn('WARNING: model-created DONE.flag detected and rejected. Only the Driver may complete.')
      } else {
        renderer.success('DONE flag (driver-verified) detected — loop completed')
        finishLoopRun('succeeded')
        return
      }
    }
    if (existsSync(join(loopDir, 'PARKED.flag'))) {
      renderer.warn('PARKED flag detected — loop paused')
      finishLoopRun('cancelled')
      return
    }

    renderer.info(`\n=== Loop iteration ${iter}/${maxIters} ===`)

    // Read current state
    const state = tryRead(join(loopDir, 'STATE.md'))

    // Construct prompt
    const prompt = `You are executing LOOP autonomous iteration ${iter}/${maxIters}.

Read these files in order:
- .loop/STATE.md (where we are)
- .loop/GOAL.md (what to achieve)
- .loop/ACCEPTANCE.md (exit criteria)
- .loop/skills/CONVENTIONS.md (project conventions)
- .loop/skills/COMMANDS.md (build/test/lint commands)
- .loop/skills/PITFALLS.md (known pitfalls)

Execute one iteration:
1. PLAN — read state, decide what to do this iteration
2. DO — make real changes (Edit/Write/Bash), commit each logical unit
3. REVIEW — use Agent tool with explore type to review your changes
4. CHECK — run quality gates (tsc --noEmit, eslint, vitest) + acceptance checks
5. ACT — if all acceptance passes + quality gates green: write .loop/CANDIDATE_DONE.flag
   Otherwise: rewrite .loop/STATE.md with progress, append .loop/HISTORY.md

Rules:
- You MUST NOT create .loop/DONE.flag. Only the external Supervisor may do that.
- To signal completion, create .loop/CANDIDATE_DONE.flag. The Supervisor will independently verify.
- Never block waiting for human confirmation — proceed with best judgment
- If stuck 3 iterations on same issue: write .loop/PARKED.flag with reason
- Always commit changes with descriptive messages
- Don't modify ACCEPTANCE.md to pass — fix code instead

Current STATE.md:
${state || '(empty — first iteration)'}

GOAL.md:
${goal}

ACCEPTANCE.md:
${acceptanceRaw || '(none — propose one based on GOAL)'}`

    // v0.3.3 (tha_goal §5.1): re-read acceptance EACH iteration (it may
    // have been updated since the last turn). Do NOT trust a cached copy.
    const acceptanceRawFresh = tryRead(join(loopDir, 'ACCEPTANCE.md'))
    const acceptanceItemsFresh = parseAcceptance(acceptanceRawFresh)

    // v0.3.4: declare before try block so it's visible in the completion gate
    let lastOutcome: { completion: { status: string } } | undefined

    // v0.3.3 (tha_goal §5.2): check for model's CANDIDATE_DONE signal.
    // If present, the model claims completion — the Driver MUST verify
    // independently before accepting.
    const candidateDonePath = join(loopDir, 'CANDIDATE_DONE.flag')
    if (existsSync(candidateDonePath)) {
      renderer.info('Model signalled CANDIDATE_DONE — Driver verifying acceptance...')
      try { unlinkSync(candidateDonePath) } catch { /* best-effort */ }
      // Run acceptance checks ourselves (don't trust the agent)
      if (acceptanceItemsFresh.length === 0) {
        renderer.warn('CANDIDATE_DONE rejected — no acceptance criteria defined')
      } else {
        let candidatePassed = true
        for (const item of acceptanceItemsFresh) {
          const result = runAcceptance(item.command, cwd, getTimeoutMs(item.id))
          if (!result.passed) { candidatePassed = false; break }
        }
        if (candidatePassed) {
          const gates = runQualityGates(cwd)
          if (gates.passed) {
            renderer.success('\n✓ Driver-verified all acceptance + quality gates — DONE!')
            writeFileSync(donePath, `DRIVER_VERIFIED at iteration ${iter}\n`, 'utf8')
            finishLoopRun('succeeded')
            return
          }
        }
        renderer.warn('CANDIDATE_DONE rejected — acceptance or gates failed')
      }
    }

    // Run engine turn
    const startMs = Date.now()
    try {
      // P1-2 fix: thread the loopRunId as parentRunId so this turn —
      // and every grandchild Agent/Worker run it spawns — links back
      // to the kind='loop' run in the Run tree. Previously runTurn
      // accepted no parentRunId, orphaning all loop turns.
      const { result, outcome: turnOutcome } = await engine.runTurn(prompt, [], undefined, { parentRunId: loopRunId })
      const elapsed = ((Date.now() - startMs) / 1000).toFixed(1)
      const statusDisplay = turnOutcome?.completion?.status ?? result.reason
      renderer.info(`Iteration ${iter} done in ${elapsed}s · ${statusDisplay}`)
      lastOutcome = turnOutcome
    } catch (err: unknown) {
      renderer.error(`Iteration ${iter} error: ${(err as Error).message}`)
    }

    // Run acceptance checks ourselves (don't trust the agent's self-assessment)
    // v0.3.3: uses the FRESH acceptance items re-read this iteration.
    renderer.info('\n--- Acceptance checks ---')
    let allPassed = true
    const results: AcceptanceResult[] = []

    // v0.3.3 (tha_goal §5.1): empty acceptance → blocked, not pass.
    if (acceptanceItemsFresh.length === 0) {
      renderer.warn('No acceptance criteria defined — cannot verify completion')
      allPassed = false
    }

    for (const item of acceptanceItemsFresh) {
      const result = runAcceptance(item.command, cwd, getTimeoutMs(item.id))
      results.push({ ...item, ...result })
      const icon = result.passed ? '✓' : '✗'
      renderer.info(`  ${icon} ${item.id}: ${item.command}`)
      if (!result.passed) {
        renderer.info(`    ${result.output.slice(0, 200)}`)
        allPassed = false
      }
    }

    // Run quality gates
    renderer.info('\n--- Quality gates ---')
    const gates = runQualityGates(cwd)
    for (const r of gates.results) {
      renderer.info(`  ${r}`)
    }

    // v0.3.4 (mimo_goal §Phase 3): the joint completion gate.
    // ALL conditions must be met — TurnOutcome status, acceptance, gates.
    const completionStatus = lastOutcome?.completion?.status
    const modelClaimsDone = completionStatus === 'completed'
    if (allPassed && gates.passed) {
      if (!modelClaimsDone && completionStatus) {
        // Gates pass but model outcome is NOT completed — don't DONE.
        renderer.warn(`\n⚠ Gates pass but model outcome is '${completionStatus}' — not completing.`)
      } else {
        renderer.success('\n✓ All acceptance checks passed + quality gates green — DONE!')
        writeFileSync(join(loopDir, 'DONE.flag'), `DRIVER_VERIFIED at iteration ${iter}\n`, 'utf8')
        finishLoopRun('succeeded')
        return
      }
    } else if (completionStatus === 'exhausted') {
      renderer.warn(`\n⚠ Model exhausted — saving state and parking.`)
      writeFileSync(join(loopDir, 'PARKED.flag'), `exhausted at iteration ${iter}\n`, 'utf8')
      finishLoopRun('failed', 'exhausted')
      return
    }

    renderer.warn(`\n⏳ Not done yet — ${results.filter(r => !r.passed).length} acceptance failed, gates ${gates.passed ? 'green' : 'red'}`)

    // v0.3.4 §Phase 6: save checkpoint after each iteration for crash recovery
    try {
      checkpointMgr.save({
        schemaVersion: 1, sequence: Date.now(), taskId, branch: 'main', worktree: cwd,
        iteration: iter, phase: 'iteration-complete',
        goalHash: hashContract(goal),
        acceptanceHash: hashContract(acceptanceRawFresh),
        changedFiles: [], consecutiveNoProgress: 0,
        consecutiveProviderFailures, consecutiveCommandFailures: 0,
        createdAt: restoredCp?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    } catch { /* best-effort */ }
    loopIteration = iter + 1
  }

  renderer.warn(`\nMax iterations (${maxIters}) reached. Check .loop/STATE.md for status.`)
  finishLoopRun('failed', `max iterations (${maxIters}) reached`)
}
