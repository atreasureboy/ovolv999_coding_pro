/**
 * v0.5.2 (C13 — borrowed from aider architect_coder.py):
 * tests for the architect/editor two-round flow.
 */
import { describe, it, expect } from 'vitest'
import {
  runArchitectExecutor,
  formatArchitectResult,
} from '../src/core/architectMode.js'
import type { ModelProfile } from '../src/core/model/modelRouter.js'

const PLANNER: ModelProfile = {
  id: 'planner',
  provider: 'test',
  model: 'planner-model',
  capabilities: { reasoning: 0.7, coding: 0.5, contextWindow: 8000, toolCalling: 0.5, speed: 0.9, cost: 0.9 },
  roles: ['cheap'],
  available: true,
}

const EXECUTOR: ModelProfile = {
  id: 'executor',
  provider: 'test',
  model: 'executor-model',
  capabilities: { reasoning: 0.9, coding: 0.95, contextWindow: 32000, toolCalling: 0.9, speed: 0.5, cost: 0.4 },
  roles: ['main'],
  available: true,
}

describe('Architect/editor mode (C13)', () => {
  it('runs planner then executor and returns both outputs', async () => {
    const calls: Array<{ model: string; system: string; user: string }> = []
    const llmCall = async (model: string, system: string, user: string) => {
      calls.push({ model, system, user })
      if (model === 'planner-model') return 'Step 1: edit foo.ts\nStep 2: edit bar.ts'
      return 'EDITBLOCK for foo.ts'
    }
    const r = await runArchitectExecutor({ prompt: 'add a button', planner: PLANNER, executor: EXECUTOR, llmCall })
    expect(calls.length).toBe(2)
    expect(calls[0].model).toBe('planner-model')
    expect(calls[1].model).toBe('executor-model')
    expect(r.plan).toContain('Step 1')
    expect(r.diff).toContain('EDITBLOCK')
    expect(r.executorModel).toBe('executor-model')
  })

  it('executor receives the planner output as part of the user prompt', async () => {
    let secondUserPrompt = ''
    const llmCall = async (model: string, _system: string, user: string) => {
      if (model === 'executor-model') secondUserPrompt = user
      return model === 'planner-model' ? 'the plan' : 'the diff'
    }
    await runArchitectExecutor({ prompt: 'task', planner: PLANNER, executor: EXECUTOR, llmCall })
    expect(secondUserPrompt).toContain('the plan')
    expect(secondUserPrompt).toContain('task')
  })

  it('returns empty diff when planner output is empty', async () => {
    const llmCall = async () => ''
    const r = await runArchitectExecutor({ prompt: 'noop', planner: PLANNER, executor: EXECUTOR, llmCall })
    expect(r.plan).toBe('')
    expect(r.diff).toBe('')
  })

  it('formatArchitectResult emits a clean markdown block', () => {
    const md = formatArchitectResult({ plan: 'do X', diff: 'diff Y', executorModel: 'm' })
    expect(md).toContain('## Plan')
    expect(md).toContain('do X')
    expect(md).toContain('## Diff (m)')
    expect(md).toContain('diff Y')
  })

  it('formatArchitectResult reports an aborted planner', () => {
    const md = formatArchitectResult({ plan: '', diff: '', executorModel: 'm' })
    expect(md).toContain('no plan')
  })
})