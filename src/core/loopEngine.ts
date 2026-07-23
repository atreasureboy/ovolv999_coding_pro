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

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
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

function runAcceptance(command: string, cwd: string): { passed: boolean; output: string } {
  try {
    const output = execSync(command, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 })
    return { passed: true, output: output.trim().slice(0, 500) }
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    const output = ((e.stdout ?? '') + (e.stderr ?? '')).trim().slice(0, 500)
    return { passed: false, output: output || e.message || 'failed' }
  }
}

function runQualityGates(cwd: string): { passed: boolean; results: string[] } {
  const results: string[] = []
  let allPassed = true

  const commands = [
    { name: 'typecheck', cmd: 'npx tsc --noEmit 2>&1' },
    { name: 'lint', cmd: 'npx eslint src/ bin/ tests/ 2>&1' },
  ]

  for (const { name, cmd } of commands) {
    const result = runAcceptance(cmd, cwd)
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

  const goal = tryRead(join(loopDir, 'GOAL.md'))
  const acceptanceRaw = tryRead(join(loopDir, 'ACCEPTANCE.md'))
  const acceptanceItems = parseAcceptance(acceptanceRaw)

  if (!goal) {
    renderer.error('GOAL.md not found or empty')
    return
  }

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
    if (!loopRunId || !registry) return
    try {
      const r = registry.get(loopRunId)
      if (r && !isTerminalRunStatus(r.status)) {
        registry.transition(loopRunId, status, { phase: 'completed', error: err })
      }
    } catch { /* best-effort */ }
  }

  for (let iter = 1; iter <= maxIters; iter++) {
    // Check for DONE/PARKED flags
    if (existsSync(join(loopDir, 'DONE.flag'))) {
      renderer.success('DONE flag detected — loop completed successfully')
      finishLoopRun('succeeded')
      return
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
5. ACT — if all acceptance passes + quality gates green: write .loop/DONE.flag
   Otherwise: rewrite .loop/STATE.md with progress, append .loop/HISTORY.md

Rules:
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

    // Run engine turn
    const startMs = Date.now()
    try {
      // P1-2 fix: thread the loopRunId as parentRunId so this turn —
      // and every grandchild Agent/Worker run it spawns — links back
      // to the kind='loop' run in the Run tree. Previously runTurn
      // accepted no parentRunId, orphaning all loop turns.
      const { result } = await engine.runTurn(prompt, [], undefined, { parentRunId: loopRunId })
      const elapsed = ((Date.now() - startMs) / 1000).toFixed(1)
      renderer.info(`Iteration ${iter} done in ${elapsed}s · ${result.reason}`)
    } catch (err: unknown) {
      renderer.error(`Iteration ${iter} error: ${(err as Error).message}`)
    }

    // Run acceptance checks ourselves (don't trust the agent's self-assessment)
    renderer.info('\n--- Acceptance checks ---')
    let allPassed = true
    const results: AcceptanceResult[] = []
    for (const item of acceptanceItems) {
      const result = runAcceptance(item.command, cwd)
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

    if (allPassed && gates.passed) {
      renderer.success('\n✓ All acceptance checks passed + quality gates green — DONE!')
      writeFileSync(join(loopDir, 'DONE.flag'), `completed at iteration ${iter}\n`, 'utf8')
      finishLoopRun('succeeded')
      return
    }

    renderer.warn(`\n⏳ Not done yet — ${results.filter(r => !r.passed).length} acceptance failed, gates ${gates.passed ? 'green' : 'red'}`)
  }

  renderer.warn(`\nMax iterations (${maxIters}) reached. Check .loop/STATE.md for status.`)
  finishLoopRun('failed', `max iterations (${maxIters}) reached`)
}
