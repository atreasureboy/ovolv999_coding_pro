/**
 * Loop Engine — built-in autonomous loop protocol.
 *
 * Implements the WAKE → SCAN → PLAN → DO → REVIEW → CHECK → ACT cycle
 * as a native ovolv999 capability
 * instead of external shell scripts calling `claude -p`.
 *
 * Usage: `ovolv999 --loop`
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
import { randomUUID } from 'crypto'
import { runCommandSync } from './commandRunner.js'
import { LoopLeaseManager, CheckpointManager, hashContract, type HeartbeatInfo, type LoopCheckpoint } from './loopSupervisor.js'
import type { ExecutionEngine } from './engine.js'
import type { RendererInterface } from '../ui/renderer.js'
import { isTerminalRunStatus } from './executionRun.js'
import type { TurnOutcome } from './runtime/turnOutcome.js'

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
  /** v0.3.4: resume from checkpoint if available (default true) */
  resume?: boolean
  /** v0.3.4: discard checkpoint and start fresh */
  restart?: boolean
}

export interface CompletionCandidate {
  runId: string
  completionStatus: 'completed'
  goalHash: string
  acceptanceHash: string
  checkpointSequence: number
}

export function parseCompletionCandidate(content: string): CompletionCandidate | null {
  try {
    const value = JSON.parse(content) as Partial<CompletionCandidate>
    if (
      typeof value.runId !== 'string'
      || value.completionStatus !== 'completed'
      || typeof value.goalHash !== 'string'
      || typeof value.acceptanceHash !== 'string'
      || !Number.isSafeInteger(value.checkpointSequence)
    ) return null
    return value as CompletionCandidate
  } catch {
    return null
  }
}

export interface DoneFlagPayload {
  marker: 'DRIVER_VERIFIED'
  nonce: string
  runId: string
  iteration: number
  checkpointSequence: number
  goalHash: string
  acceptanceHash: string
  gates: string[]
  completedAt: string
}

export function parseDoneFlag(content: string): DoneFlagPayload | null {
  try {
    const value = JSON.parse(content) as Partial<DoneFlagPayload>
    if (
      value.marker !== 'DRIVER_VERIFIED'
      || typeof value.nonce !== 'string'
      || typeof value.runId !== 'string'
      || !Number.isSafeInteger(value.iteration)
      || !Number.isSafeInteger(value.checkpointSequence)
      || typeof value.goalHash !== 'string'
      || typeof value.acceptanceHash !== 'string'
      || !Array.isArray(value.gates)
      || !value.gates.every((gate) => typeof gate === 'string')
      || typeof value.completedAt !== 'string'
    ) return null
    return value as DoneFlagPayload
  } catch {
    return null
  }
}

/**
 * ADR-007 (DONE.flag integrity): a DONE.flag is trusted only with proof the
 * Driver authored it. 'nonce' — carries this process's in-memory UUID, which
 * never touches disk or a prompt, so a model cannot forge it. 'checkpoint' —
 * binds to a phase='succeeded' checkpoint (cross-restart resume: the nonce
 * died with the previous process, but the Driver-signed checkpoint survived).
 */
export function verifyDoneFlag(flag: DoneFlagPayload, ctx: {
  driverNonce: string
  checkpoint: LoopCheckpoint | null
  liveGoalHash: string
  liveAcceptanceHash: string
}): 'nonce' | 'checkpoint' | null {
  if (flag.nonce === ctx.driverNonce) return 'nonce'
  const cp = ctx.checkpoint
  if (
    cp !== null
    && cp.phase === 'succeeded'
    && typeof cp.runId === 'string'
    && flag.runId === cp.runId
    && flag.checkpointSequence === cp.sequence
    && flag.gates.every((gate) => (cp.passedQualityGates ?? []).includes(gate))
    && flag.goalHash === ctx.liveGoalHash
    && flag.acceptanceHash === ctx.liveAcceptanceHash
  ) return 'checkpoint'
  return null
}

export function renderDoneFlag(payload: DoneFlagPayload): string {
  return JSON.stringify(payload, null, 2) + '\n'
}

export function shouldParkLoop(input: {
  heartbeatWriteFailures: number
  consecutiveNoProgress: number
}): 'heartbeat' | 'stall' | null {
  if (input.heartbeatWriteFailures >= 3) return 'heartbeat'
  if (input.consecutiveNoProgress >= 3) return 'stall'
  return null
}

export function canPromoteCompletion(input: {
  acceptancePassed: boolean
  fastGatesPassed: boolean
  candidateMatches: boolean
  completionStatus?: string
  taskGraphPassed: boolean
  workersPassed: boolean
}): boolean {
  return input.acceptancePassed
    && input.fastGatesPassed
    && input.candidateMatches
    && input.completionStatus === 'completed'
    && input.taskGraphPassed
    && input.workersPassed
}

export function canReuseGateEvidence(
  checkpoint: LoopCheckpoint | null,
  goalHash: string,
  acceptanceHash: string,
  requiredGates: string[],
  workspace: { branch: string; head?: string; changedFiles: string[]; evidenceHash: string },
): boolean {
  return checkpoint !== null
    && checkpoint.goalHash === goalHash
    && checkpoint.acceptanceHash === acceptanceHash
    && checkpoint.branch === workspace.branch
    && checkpoint.head === workspace.head
    && checkpoint.workspaceEvidenceHash === workspace.evidenceHash
    && JSON.stringify(checkpoint.changedFiles.slice().sort()) === JSON.stringify(workspace.changedFiles.slice().sort())
    && requiredGates.every((gate) => checkpoint.passedQualityGates?.includes(gate))
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
 * v0.3.4 (durable supervisor contract §Phase 8): configurable timeouts per command type.
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

function projectScripts(cwd: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    return parsed.scripts ?? {}
  } catch {
    return {}
  }
}

function gitValue(cwd: string, command: string): string {
  const result = runCommandSync({ executable: command, args: [], cwd, shell: true, timeoutMs: 10_000 })
  return result.exitCode === 0 ? (result.stdout ?? '').trim() : ''
}

function gitSnapshot(cwd: string): { branch: string; head?: string; changedFiles: string[] } {
  const branch = gitValue(cwd, 'git branch --show-current') || 'detached'
  const head = gitValue(cwd, 'git rev-parse HEAD') || undefined
  const changedFiles = gitValue(cwd, 'git status --porcelain')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
  return { branch, head, changedFiles }
}

function gitProgressEvidence(cwd: string): string {
  return hashContract(JSON.stringify({
    ...gitSnapshot(cwd),
    unstaged: gitValue(cwd, 'git diff --binary --no-ext-diff'),
    staged: gitValue(cwd, 'git diff --cached --binary --no-ext-diff'),
  }))
}

function readProviderCircuit(engine: ExecutionEngine): {
  status: 'closed' | 'open' | 'half-open'
  consecutiveFailures: number
  lastFailureAt: number
} {
  return engine.getProviderCircuitState?.() ?? {
    status: 'closed',
    consecutiveFailures: 0,
    lastFailureAt: 0,
  }
}

function runQualityGates(cwd: string): { passed: boolean; results: string[] } {
  const results: string[] = []
  let allPassed = true
  const scripts = projectScripts(cwd)
  const commands = ['typecheck', 'lint']
    .filter(name => Boolean(scripts[name]))
    .map(name => ({ name, cmd: `npm run ${name} 2>&1` }))

  for (const { name, cmd } of commands) {
    const result = runAcceptance(cmd, cwd, getTimeoutMs(name))
    if (result.passed) {
      results.push(`✓ ${name}`)
    } else {
      results.push(`✗ ${name}: ${result.output.slice(0, 200)}`)
      allPassed = false
    }
  }
  if (commands.length === 0) results.push('· no fast project gates detected')

  return { passed: allPassed, results }
}

/**
 * v0.3.4 (durable supervisor contract §Phase 8): Full quality gates run only when fast gates
 * pass AND the model claims completion. Includes test + eval + build —
 * the heavyweight commands that are too slow for every iteration.
 */
function runFullGates(cwd: string): { passed: boolean; results: string[] } {
  const results: string[] = []
  let allPassed = true
  const scripts = projectScripts(cwd)
  const commands = ['test', 'eval:deterministic', 'build']
    .filter(name => Boolean(scripts[name]))
    .map(name => ({ name, cmd: `npm run ${name} 2>&1` }))

  for (const { name, cmd } of commands) {
    const result = runAcceptance(cmd, cwd, getTimeoutMs(name))
    if (result.passed) {
      results.push(`✓ ${name}`)
    } else {
      results.push(`✗ ${name}: ${result.output.slice(0, 200)}`)
      allPassed = false
    }
  }
  if (commands.length === 0) results.push('· no full project gates detected')

  return { passed: allPassed, results }
}

/** Run the autonomous loop */
export async function runLoop(
  engine: ExecutionEngine,
  renderer: RendererInterface,
  config: LoopConfig,
): Promise<void> {
  const { cwd, loopDir } = config
  const maxIters = config.maxIters || MAX_ITERS

  // Ensure .loop/ exists
  if (!existsSync(loopDir)) {
    renderer.error(
      `Loop workspace not initialized: ${loopDir}\n` +
      `Run: ovolv999 --cwd ${JSON.stringify(cwd)} --loop-init "describe the goal"`,
    )
    return
  }

  // Read goal early — needed for taskId before lease acquisition
  const goal = tryRead(join(loopDir, 'GOAL.md'))
  const acceptanceRaw = tryRead(join(loopDir, 'ACCEPTANCE.md'))

  if (!goal) {
    renderer.error(`GOAL.md not found or empty: ${join(loopDir, 'GOAL.md')}`)
    return
  }

  // v0.3.4 (durable supervisor contract §Phase 4-6): Durable lease + heartbeat + checkpoint.
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
  let consecutiveNoProgress = 0
  let lastProgressAt = new Date().toISOString()
  let checkpointSequence = 0
  let progressEvidenceHash = ''
  let passedQualityGates = new Set<string>()
  let latestOutcome: TurnOutcome | undefined
  let supervisorRunId: string = randomUUID()
  // ADR-007: per-process completion nonce — never persisted, never shown to the
  // model. A DONE.flag carrying it is proof of Driver authorship.
  const driverNonce = randomUUID()
  let heartbeatFatal = false

  // v0.3.4 (durable supervisor contract §Phase 6): resume/restart checkpoint support
  const shouldResume = config.resume !== false // default: try resume
  const shouldRestart = config.restart === true
  let restoredCp: LoopCheckpoint | null = null
  if (shouldRestart) {
    checkpointMgr.clear()
    renderer.info('Checkpoint discarded (--restart).')
  } else if (shouldResume) {
    restoredCp = checkpointMgr.load()
    if (restoredCp) {
      loopIteration = restoredCp.iteration + 1
      consecutiveNoProgress = restoredCp.consecutiveNoProgress
      checkpointSequence = restoredCp.sequence
      lastProgressAt = restoredCp.updatedAt
      progressEvidenceHash = restoredCp.progressEvidenceHash ?? ''
      passedQualityGates = new Set(restoredCp.passedQualityGates ?? [])
      if (restoredCp.providerCircuit) {
        engine.restoreProviderCircuitState?.(restoredCp.providerCircuit)
      }
      renderer.info(`Resumed from checkpoint: iteration ${loopIteration}, ${restoredCp.consecutiveProviderFailures} prior provider failures.`)
    }
  }

  // Start heartbeat
  leaseMgr.startHeartbeat(
    (): HeartbeatInfo => {
      const circuit = readProviderCircuit(engine)
      return {
        iteration: loopIteration,
        phase: 'executing',
        lastProgressAt,
        workerCount: 0,
        circuitStatus: circuit.status,
        checkpointSequence,
      }
    },
    () => {
      if (heartbeatFatal) return
      heartbeatFatal = true
      try { writeFileSync(join(loopDir, 'PARKED.flag'), 'heartbeat persistence failed repeatedly\n', 'utf8') } catch { /* best-effort */ }
      engine.abort()
    },
  )

  const acceptanceItems = parseAcceptance(acceptanceRaw)

  renderer.info(`Loop mode: ${maxIters} max iterations · ${acceptanceItems.length} acceptance checks`)

  // v0.3.4 (durable supervisor contract §Phase 12): signal handlers for graceful shutdown.
  // On SIGINT/SIGTERM: save final checkpoint + release lease + exit.
  const signalHandler = (_sig: string) => {
    renderer.warn(`\n⚠ Signal received — saving checkpoint and shutting down.`)
    try {
      const git = gitSnapshot(cwd)
      const circuit = readProviderCircuit(engine)
      const workerReferences = (engine.getRunRegistry?.().list() ?? [])
        .filter((run) => run.kind === 'agent' || run.kind === 'external_worker')
        .map((run) => ({
          runId: run.runId,
          status: run.status,
          modelProfile: run.modelProfile,
          modelRole: run.modelRole,
          modelTier: run.modelTier,
          model: run.model,
          provider: run.provider,
          worktree: run.workspace.worktreePath,
          branch: run.workspace.branch,
        }))
      checkpointMgr.save({
        schemaVersion: 2, sequence: ++checkpointSequence, taskId, branch: git.branch, worktree: cwd,
        iteration: loopIteration, phase: 'interrupted', runId: supervisorRunId,
        turnOutcome: latestOutcome ?? restoredCp?.turnOutcome,
        taskGraph: latestOutcome?.taskGraph ?? restoredCp?.taskGraph,
        passedQualityGates: [...passedQualityGates],
        providerCircuit: circuit,
        recentCommands: acceptanceItems.map((item) => item.command),
        workerReferences,
        goalHash: hashContract(tryRead(join(loopDir, 'GOAL.md'))),
        acceptanceHash: hashContract(tryRead(join(loopDir, 'ACCEPTANCE.md'))),
        head: git.head,
        changedFiles: git.changedFiles,
        progressEvidenceHash,
        workspaceEvidenceHash: gitProgressEvidence(cwd),
        consecutiveNoProgress,
        consecutiveProviderFailures: circuit.consecutiveFailures,
        createdAt: restoredCp?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    } catch { /* best-effort */ }
    leaseMgr.stopHeartbeat()
    leaseMgr.release()
    finishLoopRun('cancelled', 'interrupted by signal')
    process.exit(130)
  }
  process.on('SIGINT', signalHandler)
  process.on('SIGTERM', signalHandler)

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
  supervisorRunId = loopRunId ?? supervisorRunId
  const finishLoopRun = (status: 'succeeded' | 'failed' | 'cancelled', err?: string) => {
    // v0.3.4: save final checkpoint + stop heartbeat + release lease
    try {
      const git = gitSnapshot(cwd)
      const circuit = readProviderCircuit(engine)
      const workerReferences = (registry?.list() ?? [])
        .filter((run) => run.kind === 'agent' || run.kind === 'external_worker')
        .map((run) => ({
          runId: run.runId,
          status: run.status,
          modelProfile: run.modelProfile,
          modelRole: run.modelRole,
          modelTier: run.modelTier,
          model: run.model,
          provider: run.provider,
          worktree: run.workspace.worktreePath,
          branch: run.workspace.branch,
        }))
      checkpointMgr.save({
        schemaVersion: 2, sequence: ++checkpointSequence, taskId, branch: git.branch, worktree: cwd,
        iteration: loopIteration, phase: status, runId: supervisorRunId,
        turnOutcome: latestOutcome ?? restoredCp?.turnOutcome,
        taskGraph: latestOutcome?.taskGraph ?? restoredCp?.taskGraph,
        passedQualityGates: [...passedQualityGates],
        providerCircuit: circuit,
        recentCommands: acceptanceItems.map((item) => item.command),
        workerReferences,
        goalHash: hashContract(tryRead(join(loopDir, 'GOAL.md'))),
        acceptanceHash: hashContract(tryRead(join(loopDir, 'ACCEPTANCE.md'))),
        head: git.head,
        changedFiles: git.changedFiles,
        progressEvidenceHash,
        workspaceEvidenceHash: gitProgressEvidence(cwd),
        consecutiveNoProgress,
        consecutiveProviderFailures: circuit.consecutiveFailures,
        createdAt: restoredCp?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(),
      })
    } catch { /* best-effort */ }
    leaseMgr.stopHeartbeat()
    leaseMgr.release()
    process.off('SIGINT', signalHandler)
    process.off('SIGTERM', signalHandler)
    if (!loopRunId || !registry) return
    try {
      const r = registry.get(loopRunId)
      if (r && !isTerminalRunStatus(r.status)) {
        registry.transition(loopRunId, status, { phase: 'completed', error: err })
      }
    } catch { /* best-effort */ }
  }

  // ADR-007: a resumed checkpoint with phase='succeeded' means the previous
  // process already completed. Exit as success without re-running iterations —
  // this also covers the crash window between checkpoint save and flag write,
  // where no DONE.flag exists on disk at all.
  if (restoredCp?.phase === 'succeeded') {
    renderer.success('Checkpoint records a prior successful completion — loop done.')
    finishLoopRun('succeeded')
    return
  }

  for (let iter = loopIteration; iter <= maxIters; iter++) {
    const parkReason = shouldParkLoop({
      heartbeatWriteFailures: leaseMgr.getHeartbeatWriteFailures(),
      consecutiveNoProgress,
    })
    if (parkReason === 'heartbeat') {
      writeFileSync(join(loopDir, 'PARKED.flag'), 'heartbeat persistence failed repeatedly\n', 'utf8')
      renderer.warn('Heartbeat persistence failed repeatedly — loop parked before starting new work.')
      finishLoopRun('cancelled', 'heartbeat persistence unavailable')
      return
    }
    if (parkReason === 'stall') {
      writeFileSync(join(loopDir, 'PARKED.flag'), 'no verified progress for three iterations\n', 'utf8')
      renderer.warn('No verified progress for three iterations — loop parked.')
      finishLoopRun('cancelled', 'stalled without verified progress')
      return
    }
    // ADR-007 (DONE.flag integrity, supersedes background autonomy contract §5.2):
    // substring matching is forgeable — a model writing "DRIVER_VERIFIED" passes
    // the old check. Now the flag must verify: nonce binding (this process) or
    // checkpoint binding (a Driver-signed phase='succeeded' checkpoint). Anything
    // else — forgery or legacy plaintext — is renamed and the loop continues.
    const donePath = join(loopDir, 'DONE.flag')
    if (existsSync(donePath)) {
      const doneFlag = parseDoneFlag(tryRead(donePath))
      const doneVerdict = doneFlag === null
        ? null
        : verifyDoneFlag(doneFlag, {
            driverNonce,
            checkpoint: checkpointMgr.load(),
            liveGoalHash: hashContract(tryRead(join(loopDir, 'GOAL.md'))),
            liveAcceptanceHash: hashContract(tryRead(join(loopDir, 'ACCEPTANCE.md'))),
          })
      if (doneFlag !== null && doneVerdict !== null) {
        renderer.success(`DONE flag verified (${doneVerdict} binding) — loop completed`)
        finishLoopRun('succeeded')
        return
      }
      try { renameSync(donePath, join(loopDir, 'DONE.flag.rejected')) } catch { /* best-effort */ }
      renderer.warn('WARNING: unverified DONE.flag rejected (no valid driver binding). Only the Driver may complete.')
    }
    if (existsSync(join(loopDir, 'PARKED.flag'))) {
      renderer.warn('PARKED flag detected — loop paused')
      finishLoopRun('cancelled')
      return
    }

    renderer.info(`\n=== Loop iteration ${iter}/${maxIters} ===`)

    // Read current state
    const state = tryRead(join(loopDir, 'STATE.md'))

    // v0.3.4 (durable supervisor contract §Phase 7): re-read + hash BOTH contracts
    // every iteration for prompt↔driver consistency, BEFORE building the prompt.
    // (Originally only ACCEPTANCE was re-read while the GOAL hash came from the
    // boot-time read — a GOAL edit mid-loop then made prompt and verification
    // disagree, and the post-turn check rejected completion forever.)
    const goalFresh = tryRead(join(loopDir, 'GOAL.md'))
    const acceptanceRawFresh = tryRead(join(loopDir, 'ACCEPTANCE.md'))
    const acceptanceItemsFresh = parseAcceptance(acceptanceRawFresh)
    const acceptanceHashThisIter = hashContract(acceptanceRawFresh)
    const goalHashThisIter = hashContract(goalFresh)

    // Construct prompt
    const prompt = `You are executing LOOP autonomous iteration ${iter}/${maxIters}.

Read these files in order:
- .loop/STATE.md (where we are)
- .loop/GOAL.md (what to achieve)
- .loop/ACCEPTANCE.md (exit criteria)
- .loop/skills/CONVENTIONS.md (project conventions)
- .loop/skills/COMMANDS.md (build/test/lint commands)
- .loop/skills/PITFALLS.md (known pitfalls)

Contract hash (for verification): goal=${goalHashThisIter} acceptance=${acceptanceHashThisIter}
Run binding: runId=${supervisorRunId} checkpointSequence=${checkpointSequence}

Execute one iteration:
1. PLAN — read state, decide what to do this iteration
2. DO — make real changes (Edit/Write/Bash), commit each logical unit
3. REVIEW — use Agent tool with explore type to review your changes
4. CHECK — run quality gates (tsc --noEmit, eslint, vitest) + acceptance checks
5. ACT — only when the work is completed, write .loop/CANDIDATE_DONE.flag as JSON:
   {"runId":"${supervisorRunId}","completionStatus":"completed","goalHash":"${goalHashThisIter}","acceptanceHash":"${acceptanceHashThisIter}","checkpointSequence":${checkpointSequence}}
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
${goalFresh}

ACCEPTANCE.md:
${acceptanceRaw || '(none — propose one based on GOAL)'}`

    // v0.3.4: acceptance re-read moved up before prompt construction (§Phase 7)
    // v0.3.4: declare before try block so it's visible in the completion gate
    let lastOutcome: TurnOutcome | undefined

    const candidateDonePath = join(loopDir, 'CANDIDATE_DONE.flag')

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
      latestOutcome = turnOutcome
      const nextProgressEvidenceHash = hashContract(JSON.stringify({
        workspace: gitProgressEvidence(cwd),
        changedFiles: turnOutcome.changedFiles.slice().sort(),
        verification: turnOutcome.verification,
        taskGraph: turnOutcome.taskGraph,
        completion: turnOutcome.completion.status,
      }))
      if (nextProgressEvidenceHash !== progressEvidenceHash
        && (turnOutcome.changedFiles.length > 0 || turnOutcome.verification.executed)) {
        lastProgressAt = new Date().toISOString()
        consecutiveNoProgress = 0
        progressEvidenceHash = nextProgressEvidenceHash
      } else {
        consecutiveNoProgress++
      }
    } catch (err: unknown) {
      renderer.error(`Iteration ${iter} error: ${(err as Error).message}`)
    }
    if (heartbeatFatal) {
      renderer.warn('Heartbeat persistence failed repeatedly — loop parked.')
      finishLoopRun('cancelled', 'heartbeat persistence unavailable')
      return
    }

    // Run acceptance checks ourselves (don't trust the agent's self-assessment)
    // v0.3.3: uses the FRESH acceptance items re-read this iteration.
    renderer.info('\n--- Acceptance checks ---')
    let allPassed = true
    const results: AcceptanceResult[] = []

    // v0.3.3 (background autonomy contract §5.1): empty acceptance → blocked, not pass.
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

    // Run quality gates — v0.3.4 (durable supervisor contract §Phase 8): split into fast/full
    renderer.info('\n--- Quality gates (fast) ---')
    const gateSnapshot = gitSnapshot(cwd)
    const gateWorkspace = { ...gateSnapshot, evidenceHash: gitProgressEvidence(cwd) }
    const restoredFastGates = canReuseGateEvidence(
      restoredCp,
      goalHashThisIter,
      acceptanceHashThisIter,
      ['typecheck', 'lint'],
      gateWorkspace,
    )
    const fastGates = restoredFastGates
      ? { passed: true, results: ['✓ typecheck (restored evidence)', '✓ lint (restored evidence)'] }
      : runQualityGates(cwd)
    if (fastGates.passed) {
      passedQualityGates.add('typecheck')
      passedQualityGates.add('lint')
    }
    for (const r of fastGates.results) {
      renderer.info(`  ${r}`)
    }

    // v0.3.4 (durable supervisor contract §Phase 7): Driver-side hash verification before DONE.
    // Re-read the contracts NOW (after the model turn) and verify the hashes
    // match what was embedded in the prompt. If they changed mid-turn, the
    // model may have operated on stale criteria — reject DONE.
    const goalHashPostTurn = hashContract(tryRead(join(loopDir, 'GOAL.md')))
    const acceptanceHashPostTurn = hashContract(tryRead(join(loopDir, 'ACCEPTANCE.md')))
    const contractChanged = goalHashPostTurn !== goalHashThisIter || acceptanceHashPostTurn !== acceptanceHashThisIter

    // v0.3.4 (durable supervisor contract §Phase 3): the joint completion gate.
    const completionStatus = lastOutcome?.completion?.status
    const modelClaimsDone = completionStatus === 'completed'
    const candidate = existsSync(candidateDonePath)
      ? parseCompletionCandidate(tryRead(candidateDonePath))
      : null
    if (existsSync(candidateDonePath)) {
      try { unlinkSync(candidateDonePath) } catch { /* best-effort */ }
    }
    const candidateMatches = candidate !== null
      && candidate.runId === supervisorRunId
      && candidate.goalHash === goalHashThisIter
      && candidate.acceptanceHash === acceptanceHashThisIter
      && candidate.checkpointSequence === checkpointSequence
    const taskNodes = ((lastOutcome?.taskGraph as { nodes?: Array<{ status?: string }> } | undefined)?.nodes) ?? []
    const taskGraphPassed = taskNodes.every((node) => node.status === 'completed')
    const currentWorkers = registry && lastOutcome
      ? registry.list({ parentRunId: lastOutcome.runId })
        .filter((run) => run.kind === 'agent' || run.kind === 'external_worker')
      : []
    const workersPassed = currentWorkers.every((run) => run.status === 'succeeded')
      && (lastOutcome?.workerReferences ?? []).every((worker) => worker.status === 'succeeded')
    if (canPromoteCompletion({
      acceptancePassed: allPassed,
      fastGatesPassed: fastGates.passed,
      candidateMatches,
      completionStatus,
      taskGraphPassed,
      workersPassed,
    })) {
      if (contractChanged) {
        renderer.warn(`\n⚠ Contract changed during turn (goal/acceptance hash mismatch). Not completing — re-run with updated criteria.`)
      } else if (!modelClaimsDone) {
        renderer.warn(`\n⚠ Gates pass but model outcome is '${completionStatus}' — not completing.`)
      } else {
        // Full gates only when fast pass + model claims done + contract stable
        renderer.info('\n--- Quality gates (full) ---')
        const restoredFullGates = canReuseGateEvidence(
          restoredCp,
          goalHashThisIter,
          acceptanceHashThisIter,
          ['test', 'build'],
          gateWorkspace,
        )
        const fullGates = restoredFullGates
          ? { passed: true, results: ['✓ test (restored evidence)', '✓ build (restored evidence)'] }
          : runFullGates(cwd)
        for (const r of fullGates.results) {
          renderer.info(`  ${r}`)
        }
        if (fullGates.passed) {
          passedQualityGates.add('test')
          passedQualityGates.add('build')
          renderer.success('\n✓ All acceptance + fast + full gates green — DONE!')
          // ADR-007: checkpoint FIRST — finishLoopRun saves phase='succeeded' at
          // ++checkpointSequence — then the bound flag referencing that sequence.
          // Crash between the two is harmless: resume short-circuits on the
          // checkpoint; the flag is forensic, not the source of truth.
          finishLoopRun('succeeded')
          const donePayload: DoneFlagPayload = {
            marker: 'DRIVER_VERIFIED',
            nonce: driverNonce,
            runId: supervisorRunId,
            iteration: iter,
            checkpointSequence,
            goalHash: goalHashPostTurn,
            acceptanceHash: acceptanceHashPostTurn,
            gates: [...passedQualityGates],
            completedAt: new Date().toISOString(),
          }
          try { writeFileSync(join(loopDir, 'DONE.flag'), renderDoneFlag(donePayload), 'utf8') } catch { /* best-effort */ }
          return
        } else {
          renderer.warn(`\n⚠ Full gates failed — not completing.`)
        }
      }
    } else if (completionStatus === 'exhausted') {
      renderer.warn(`\n⚠ Model exhausted — saving state and parking.`)
      writeFileSync(join(loopDir, 'PARKED.flag'), `exhausted at iteration ${iter}\n`, 'utf8')
      finishLoopRun('failed', 'exhausted')
      return
    }

    if (!candidateMatches) renderer.warn('\n⚠ Missing, stale, or invalid completion candidate — not completing.')
    if (!taskGraphPassed || !workersPassed) renderer.warn('\n⚠ TaskGraph or Worker state is incomplete — not completing.')
    renderer.warn(`\n⏳ Not done yet — ${results.filter(r => !r.passed).length} acceptance failed, gates ${fastGates.passed ? 'green' : 'red'}`)

    // v0.3.4 §Phase 6: save checkpoint after each iteration for crash recovery
    try {
      checkpointSequence++
      const git = gitSnapshot(cwd)
      const circuit = readProviderCircuit(engine)
      const runs = registry?.list() ?? []
      const workerReferences = runs
        .filter((run) => run.kind === 'agent' || run.kind === 'external_worker')
        .map((run) => ({
          runId: run.runId,
          status: run.status,
          modelProfile: run.modelProfile,
          modelRole: run.modelRole,
          modelTier: run.modelTier,
          model: run.model,
          provider: run.provider,
          worktree: run.workspace.worktreePath,
          branch: run.workspace.branch,
        }))
      checkpointMgr.save({
        schemaVersion: 2, sequence: checkpointSequence, taskId, branch: git.branch, worktree: cwd,
        iteration: iter, phase: 'iteration-complete',
        runId: supervisorRunId,
        turnOutcome: lastOutcome,
        taskGraph: lastOutcome?.taskGraph,
        workerReferences,
        recentCommands: acceptanceItemsFresh.map((item) => item.command),
        passedQualityGates: [...passedQualityGates],
        providerCircuit: circuit,
        goalHash: hashContract(tryRead(join(loopDir, 'GOAL.md'))),
        acceptanceHash: hashContract(acceptanceRawFresh),
        head: git.head,
        changedFiles: git.changedFiles,
        progressEvidenceHash,
        workspaceEvidenceHash: gitProgressEvidence(cwd),
        consecutiveNoProgress,
        consecutiveProviderFailures: circuit.consecutiveFailures,
        createdAt: restoredCp?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    } catch { /* best-effort */ }
    loopIteration = iter + 1
  }

  renderer.warn(`\nMax iterations (${maxIters}) reached. Check .loop/STATE.md for status.`)
  finishLoopRun('failed', `max iterations (${maxIters}) reached`)

  // v0.3.4: clean up signal handlers
  process.off('SIGINT', signalHandler)
  process.off('SIGTERM', signalHandler)
}
