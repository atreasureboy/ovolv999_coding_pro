import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseWorkflow,
  validateWorkflow,
  validateStep,
  loadWorkflows,
  loadWorkflow,
  executeWorkflow,
  writeSampleWorkflow,
  type Workflow,
  type WorkflowContext,
} from '../src/core/workflow.js'

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<WorkflowContext> = {}): WorkflowContext {
  return {
    cwd: process.cwd(),
    runSlash: async (cmd: string) => `slash result for: ${cmd}`,
    promptUser: async (msg: string, def?: string) => def ?? 'user-input',
    runAgent: async (prompt: string) => `agent result for: ${prompt}`,
    ...overrides,
  }
}

// ── Validation ──────────────────────────────────────────────────────────────

describe('parseWorkflow', () => {
  it('parses valid workflow', () => {
    const raw = JSON.stringify({
      name: 'test',
      description: 'A test',
      steps: [
        { type: 'shell', command: 'echo hello' },
      ],
    })
    const wf = parseWorkflow(raw)
    expect(wf).not.toBeNull()
    expect(wf!.name).toBe('test')
    expect(wf!.steps).toHaveLength(1)
  })

  it('returns null for invalid JSON', () => {
    expect(parseWorkflow('{invalid')).toBeNull()
  })

  it('returns null for missing name', () => {
    expect(parseWorkflow(JSON.stringify({ steps: [] }))).toBeNull()
  })

  it('returns null for empty name', () => {
    expect(parseWorkflow(JSON.stringify({ name: '', steps: [] }))).toBeNull()
  })

  it('returns null for missing steps', () => {
    expect(parseWorkflow(JSON.stringify({ name: 'test' }))).toBeNull()
  })

  it('returns null for empty steps array', () => {
    expect(parseWorkflow(JSON.stringify({ name: 'test', steps: [] }))).toBeNull()
  })
})

describe('validateStep', () => {
  it('validates shell step', () => {
    const step = validateStep({ type: 'shell', command: 'echo hi' })
    expect(step).not.toBeNull()
    expect(step!.type).toBe('shell')
    expect(step!.command).toBe('echo hi')
  })

  it('rejects invalid type', () => {
    expect(validateStep({ type: 'invalid', command: 'x' })).toBeNull()
  })

  it('rejects missing type', () => {
    expect(validateStep({ command: 'x' })).toBeNull()
  })

  it('validates echo step', () => {
    const step = validateStep({ type: 'echo', text: 'hello' })
    expect(step).not.toBeNull()
    expect(step!.type).toBe('echo')
  })

  it('validates prompt step with default', () => {
    const step = validateStep({ type: 'prompt', message: 'Name?', default: 'foo' })
    expect(step).not.toBeNull()
    expect(step!.default).toBe('foo')
  })

  it('validates condition field', () => {
    const step = validateStep({ type: 'echo', text: 'x', if: 'failure' })
    expect(step).not.toBeNull()
    expect(step!.if).toBe('failure')
  })

  it('validates continueOnError', () => {
    const step = validateStep({ type: 'shell', command: 'x', continueOnError: true })
    expect(step).not.toBeNull()
    expect(step!.continueOnError).toBe(true)
  })
})

// ── Loader ──────────────────────────────────────────────────────────────────

describe('loadWorkflows', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wf-load-'))
  })

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('returns empty map when no workflow dir', () => {
    expect(loadWorkflows(dir).size).toBe(0)
  })

  it('loads workflows from .ovolv999/workflows/', () => {
    mkdirSync(join(dir, '.ovolv999', 'workflows'), { recursive: true })
    writeFileSync(
      join(dir, '.ovolv999', 'workflows', 'a.json'),
      JSON.stringify({ name: 'wf-a', steps: [{ type: 'echo', text: 'A' }] }),
    )
    writeFileSync(
      join(dir, '.ovolv999', 'workflows', 'b.json'),
      JSON.stringify({ name: 'wf-b', steps: [{ type: 'echo', text: 'B' }] }),
    )
    const workflows = loadWorkflows(dir)
    expect(workflows.size).toBe(2)
    expect(workflows.has('wf-a')).toBe(true)
    expect(workflows.has('wf-b')).toBe(true)
  })

  it('skips malformed files', () => {
    mkdirSync(join(dir, '.ovolv999', 'workflows'), { recursive: true })
    writeFileSync(join(dir, '.ovolv999', 'workflows', 'bad.json'), '{invalid')
    writeFileSync(
      join(dir, '.ovolv999', 'workflows', 'good.json'),
      JSON.stringify({ name: 'good', steps: [{ type: 'echo', text: 'ok' }] }),
    )
    const workflows = loadWorkflows(dir)
    expect(workflows.size).toBe(1)
    expect(workflows.has('good')).toBe(true)
  })

  it('ignores non-JSON files', () => {
    mkdirSync(join(dir, '.ovolv999', 'workflows'), { recursive: true })
    writeFileSync(join(dir, '.ovolv999', 'workflows', 'readme.md'), '# docs')
    expect(loadWorkflows(dir).size).toBe(0)
  })

  it('loadWorkflow returns single by name', () => {
    mkdirSync(join(dir, '.ovolv999', 'workflows'), { recursive: true })
    writeFileSync(
      join(dir, '.ovolv999', 'workflows', 'x.json'),
      JSON.stringify({ name: 'the-one', steps: [{ type: 'echo', text: 'X' }] }),
    )
    expect(loadWorkflow(dir, 'the-one')).not.toBeNull()
    expect(loadWorkflow(dir, 'nonexistent')).toBeNull()
  })
})

// ── Execution ───────────────────────────────────────────────────────────────

describe('executeWorkflow', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wf-exec-'))
  })

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('executes a simple echo step', async () => {
    const wf: Workflow = {
      name: 'echo-test',
      steps: [{ name: 'greet', type: 'echo', text: 'Hello World' }],
    }
    const result = await executeWorkflow(wf, makeCtx({ cwd: dir }))
    expect(result.success).toBe(true)
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0].output).toBe('Hello World')
  })

  it('executes a shell step successfully', async () => {
    const wf: Workflow = {
      name: 'shell-test',
      steps: [{ name: 'echo', type: 'shell', command: 'echo "test output"' }],
    }
    const result = await executeWorkflow(wf, makeCtx({ cwd: dir }))
    expect(result.success).toBe(true)
    expect(result.steps[0].output).toContain('test output')
  })

  it('fails on shell error without continueOnError', async () => {
    const wf: Workflow = {
      name: 'fail-test',
      steps: [
        { name: 'fail', type: 'shell', command: 'exit 1' },
        { name: 'after', type: 'echo', text: 'should not run' },
      ],
    }
    const result = await executeWorkflow(wf, makeCtx({ cwd: dir }))
    expect(result.success).toBe(false)
    expect(result.steps).toHaveLength(1) // Stopped after first failure
    expect(result.steps[0].success).toBe(false)
  })

  it('continues on error with continueOnError', async () => {
    const wf: Workflow = {
      name: 'continue-test',
      steps: [
        { name: 'fail', type: 'shell', command: 'exit 1', continueOnError: true },
        { name: 'after', type: 'echo', text: 'ran after failure' },
      ],
    }
    const result = await executeWorkflow(wf, makeCtx({ cwd: dir }))
    expect(result.steps).toHaveLength(2)
    expect(result.steps[0].success).toBe(false)
    expect(result.steps[1].success).toBe(true)
  })

  it('respects if: success condition', async () => {
    const wf: Workflow = {
      name: 'cond-test',
      steps: [
        { name: 'ok', type: 'shell', command: 'echo ok' },
        { name: 'after-success', type: 'echo', text: 'ran', if: 'success' },
      ],
    }
    const result = await executeWorkflow(wf, makeCtx({ cwd: dir }))
    expect(result.steps[1].output).toBe('ran')
  })

  it('skips if: success when previous failed', async () => {
    const wf: Workflow = {
      name: 'cond-skip',
      steps: [
        { name: 'fail', type: 'shell', command: 'exit 1', continueOnError: true },
        { name: 'after-success', type: 'echo', text: 'should skip', if: 'success' },
      ],
    }
    const result = await executeWorkflow(wf, makeCtx({ cwd: dir }))
    expect(result.steps[1].output).toContain('skipped')
  })

  it('runs if: failure when previous failed', async () => {
    const wf: Workflow = {
      name: 'cond-fail',
      steps: [
        { name: 'fail', type: 'shell', command: 'exit 1', continueOnError: true },
        { name: 'cleanup', type: 'echo', text: 'cleanup ran', if: 'failure' },
      ],
    }
    const result = await executeWorkflow(wf, makeCtx({ cwd: dir }))
    expect(result.steps[1].output).toBe('cleanup ran')
  })

  it('runs if: always regardless of previous result', async () => {
    const wf: Workflow = {
      name: 'cond-always',
      steps: [
        { name: 'fail', type: 'shell', command: 'exit 1', continueOnError: true },
        { name: 'always', type: 'echo', text: 'always runs', if: 'always' },
      ],
    }
    const result = await executeWorkflow(wf, makeCtx({ cwd: dir }))
    expect(result.steps[1].output).toBe('always runs')
  })

  it('runs slash step via runner', async () => {
    const wf: Workflow = {
      name: 'slash-test',
      steps: [{ name: 'cmd', type: 'slash', command: '/cost' }],
    }
    const result = await executeWorkflow(wf, makeCtx({ cwd: dir }))
    expect(result.steps[0].success).toBe(true)
    expect(result.steps[0].output).toContain('/cost')
  })

  it('errors on slash without runner', async () => {
    const wf: Workflow = {
      name: 'no-runner',
      steps: [{ type: 'slash', command: '/cost' }],
    }
    const result = await executeWorkflow(wf, { cwd: dir })
    expect(result.steps[0].success).toBe(false)
    expect(result.steps[0].error).toContain('No slash runner')
  })

  it('runs prompt step with default', async () => {
    const wf: Workflow = {
      name: 'prompt-test',
      steps: [{ name: 'ask', type: 'prompt', message: 'Name?', default: 'default-val' }],
    }
    const result = await executeWorkflow(wf, makeCtx({ cwd: dir }))
    expect(result.steps[0].success).toBe(true)
    expect(result.steps[0].value).toBe('default-val')
  })

  it('runs agent step via runner', async () => {
    const wf: Workflow = {
      name: 'agent-test',
      steps: [{
        name: 'worker', type: 'agent',
        prompt: 'do stuff', preset: 'general-purpose',
      }],
    }
    const result = await executeWorkflow(wf, makeCtx({ cwd: dir }))
    expect(result.steps[0].success).toBe(true)
    expect(result.steps[0].output).toContain('agent result')
  })

  it('respects custom cwd for shell steps', async () => {
    mkdirSync(join(dir, 'subdir'), { recursive: true })
    const wf: Workflow = {
      name: 'cwd-test',
      steps: [{ name: 'pwd', type: 'shell', command: 'pwd', cwd: 'subdir' }],
    }
    const result = await executeWorkflow(wf, makeCtx({ cwd: dir }))
    expect(result.steps[0].output).toContain('subdir')
  })

  it('records duration for each step', async () => {
    const wf: Workflow = {
      name: 'timing',
      steps: [{ type: 'shell', command: 'sleep 0.1' }],
    }
    const result = await executeWorkflow(wf, makeCtx({ cwd: dir }))
    expect(result.steps[0].durationMs).toBeGreaterThanOrEqual(80)
    expect(result.durationMs).toBeGreaterThanOrEqual(result.steps[0].durationMs)
  })

  it('captures exitCode on shell failure', async () => {
    const wf: Workflow = {
      name: 'exit-code',
      steps: [{ type: 'shell', command: 'exit 42', continueOnError: true }],
    }
    const result = await executeWorkflow(wf, makeCtx({ cwd: dir }))
    expect(result.steps[0].exitCode).toBe(42)
  })

  it('records error message on shell failure', async () => {
    const wf: Workflow = {
      name: 'err-msg',
      steps: [{ type: 'shell', command: 'nonexistent-command-xyz', continueOnError: true }],
    }
    const result = await executeWorkflow(wf, makeCtx({ cwd: dir }))
    expect(result.steps[0].success).toBe(false)
    expect(result.steps[0].error).toBeTruthy()
  })
})

// ── Sample writer ───────────────────────────────────────────────────────────

describe('writeSampleWorkflow', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wf-sample-'))
  })

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('creates a sample workflow file', () => {
    const path = writeSampleWorkflow(dir, 'my-sample')
    const wf = loadWorkflow(dir, 'my-sample')
    expect(wf).not.toBeNull()
    expect(wf!.name).toBe('my-sample')
    expect(wf!.steps.length).toBeGreaterThan(0)
  })

  it('creates the workflows directory', () => {
    writeSampleWorkflow(dir, 'test')
    expect(() => loadWorkflow(dir, 'test')).not.toThrow()
  })
})
