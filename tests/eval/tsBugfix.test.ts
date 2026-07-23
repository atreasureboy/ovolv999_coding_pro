/**
 * Deterministic Coding Eval (eight_goal Phase 6).
 *
 * One real end-to-end task: fix a one-line bug in a TypeScript file.
 * The agent trajectory is scripted (a Fake Provider emits the Edit
 * tool_call), but everything else is REAL: ExecutionEngine →
 * ProviderAdapter → RuntimeCoordinator → ToolScheduler → ToolExecutor
 * → Edit tool → file write. The scorer then verifies the OUTCOME
 * (file matches expected + node compiles it) — not the trajectory.
 *
 * This is the eval foundation: it proves the runtime can turn a model
 * decision into a correct, verified change, and that scoring + baseline
 * comparison work. Real-model eval (`eval:real`) is optional and not
 * CI-gated. Baseline lives in baselines.json.
 *
 * Run: pnpm eval:deterministic   (or npx vitest run tests/eval/)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { ExecutionEngine } from '../../src/core/engine.js'
import type { EngineConfig, Tool } from '../../src/core/types.js'
import type { Renderer } from '../../src/ui/renderer.js'

// ── Fake provider: a scripted OpenAI-shaped stream ────────────────
type Queued = { k: 's'; s: AsyncIterable<unknown> } | { k: 'e'; e: Error }
class FakeOpenAI {
  createCalls = 0
  private q: Queued[] = []
  chat = {
    completions: {
      create: (_p: Record<string, unknown>, o: { signal: AbortSignal }) => {
        this.createCalls++
        const n = this.q[this.createCalls - 1] ?? { k: 'e' as const, e: new Error('parked') }
        return new Promise<AsyncIterable<unknown>>((res, rej) => {
          if (o.signal.aborted) { rej(new Error('aborted')); return }
          o.signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true })
          if (n.k === 's') res(n.s); else rej(n.e)
        })
      },
    },
  }
  push(s: AsyncIterable<unknown>) { this.q.push({ k: 's', s }) }
}

function toolCallStream(name: string, args: Record<string, unknown>): AsyncIterable<unknown> {
  return (async function* () {
    await Promise.resolve()
    yield {
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, id: 'call_fix', function: { name, arguments: JSON.stringify(args) } }] },
        finish_reason: null,
      }],
    }
    yield { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
  })()
}
function stopStream(text: string): AsyncIterable<unknown> {
  return (async function* () {
    await Promise.resolve()
    yield { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }
    yield { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }
  })()
}

function fakeRenderer(): Renderer {
  const r: Record<string, (...args: unknown[]) => void> = {}
  for (const k of ['banner', 'raw', 'info', 'warn', 'error', 'success', 'startSpinner', 'stopSpinner', 'beginAssistantText', 'endAssistantText', 'streamToken', 'assistantMessage', 'userMessage', 'toolCall', 'toolStart', 'toolResult', 'compactStart', 'compactDone', 'contextWarning', 'cost', 'compactionNotice', 'turnEnd', 'planModeHeader', 'agentStart', 'agentDone', 'agentSummary', 'agentHeartbeat']) r[k] = () => {}
  return r as unknown as Renderer
}

// ── fixture: a buggy add() ────────────────────────────────────────
const BUGGY = `export function add(a: number, b: number): number {\n  return a + b + 1\n}\n`
const FIXED = `export function add(a: number, b: number): number {\n  return a + b\n}\n`

const BASELINE = { taskCompleted: true, fileFixed: true, compiles: true, falseSuccess: false, toolCalls: 2 }

let dir = ''
beforeEach(() => { dir = mkdtempSync(`${tmpdir}/eval-`) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('eval: TS single-file bugfix (deterministic)', () => {
  it('fixes the off-by-one bug via a real Edit tool call and verifies', async () => {
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'add.ts'), BUGGY, 'utf8')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'eval-fixture', type: 'module' }), 'utf8')

    const cfg: EngineConfig = {
      model: 'fake-model', apiKey: 'k', maxIterations: 5, cwd: dir,
      permissionMode: 'auto', permissionManager: undefined, enabledModules: [],
    }
    const fake = new FakeOpenAI()
    // Scripted trajectory: turn 1 = Read the file (Edit enforces
    // read-before-edit); turn 2 = Edit (remove the +1); turn 3 = stop.
    fake.push(toolCallStream('Read', { file_path: join(dir, 'src', 'add.ts') }))
    fake.push(toolCallStream('Edit', {
      file_path: join(dir, 'src', 'add.ts'),
      old_string: '  return a + b + 1\n',
      new_string: '  return a + b\n',
    }))
    fake.push(stopStream('Fixed the off-by-one in add().'))

    const engine = new ExecutionEngine(cfg, fakeRenderer(), fake as unknown as never)
    const { result } = await engine.runTurn('Fix the bug in src/add.ts so add(2,3) returns 5.', [])

    // ── score ──
    const after = readFileSync(join(dir, 'src', 'add.ts'), 'utf8')
    const fileFixed = after === FIXED
    // Real verification: a runner that imports the fixed .ts (via tsx,
    // a devDependency) and asserts add(2,3)===5. Confirms the change is
    // not just textually different but actually correct + runnable.
    writeFileSync(join(dir, 'verify.mts'), `import { add } from './src/add.ts'\nif (add(2,3) !== 5) process.exit(1)\n`, 'utf8')
    let compiles = false
    try {
      execSync('npx tsx verify.mts', { cwd: dir, stdio: 'pipe', timeout: 30_000 })
      compiles = true
    } catch { compiles = false }

    const score = {
      taskCompleted: result.reason === 'stop_sequence',
      fileFixed,
      compiles,
      falseSuccess: result.reason === 'stop_sequence' && !fileFixed,
      toolCalls: fake.createCalls - 1, // last call was the stop summary
    }

    // ── baseline comparison (regression gate) ──
    expect(score).toEqual(BASELINE)
    expect(score.falseSuccess).toBe(false)
  }, 30_000)
})
