import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createGoal,
  getGoal,
  listGoals,
  updateGoal,
  deleteGoal,
  addSubtask,
  updateSubtask,
  getNextSubtask,
  startGoal,
  completeGoal,
  failGoal,
  pauseGoal,
  resumeGoal,
  retryGoal,
  addContext,
  getProgress,
  formatGoal,
  formatGoalList,
  resetGoalStore,
} from '../src/core/goals.js'

describe('goals', () => {
let testDir: string

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), 'ovolv999-goals-'))
  process.env.OVOLV999_TEST_STORE_DIR = testDir
})

beforeEach(() => {
  resetGoalStore()
})

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true })
  delete process.env.OVOLV999_TEST_STORE_DIR
})

  describe('createGoal', () => {
    it('creates a goal with objective', () => {
      const g = createGoal('Fix all type errors')
      expect(g.objective).toBe('Fix all type errors')
      expect(g.status).toBe('pending')
      expect(g.priority).toBe('medium')
      expect(g.subtasks).toHaveLength(0)
      expect(g.id).toMatch(/^goal-/)
    })

    it('creates with subtasks', () => {
      const g = createGoal('Refactor module', {
        subtasks: ['Read existing code', 'Plan changes', 'Implement'],
      })
      expect(g.subtasks).toHaveLength(3)
      expect(g.subtasks[0].status).toBe('pending')
    })

    it('creates with priority and tags', () => {
      const g = createGoal('Deploy', { priority: 'critical', tags: ['prod', 'urgent'] })
      expect(g.priority).toBe('critical')
      expect(g.tags).toEqual(['prod', 'urgent'])
    })

    it('has maxAttempts default', () => {
      const g = createGoal('test')
      expect(g.maxAttempts).toBe(5)
    })
  })

  describe('getGoal', () => {
    it('returns created goal', () => {
      const g = createGoal('test')
      const fetched = getGoal(g.id)
      expect(fetched).toBeDefined()
      expect(fetched!.id).toBe(g.id)
    })

    it('returns undefined for unknown id', () => {
      expect(getGoal('unknown')).toBeUndefined()
    })
  })

  describe('listGoals', () => {
    it('lists all goals', () => {
      createGoal('one')
      createGoal('two')
      const list = listGoals()
      expect(list).toHaveLength(2)
    })

    it('filters by status', () => {
      const g1 = createGoal('active')
      createGoal('inactive')
      startGoal(g1.id)
      const inProgress = listGoals({ status: 'in_progress' })
      expect(inProgress).toHaveLength(1)
      expect(inProgress[0].objective).toBe('active')
    })

    it('filters by priority', () => {
      createGoal('low', { priority: 'low' })
      createGoal('high', { priority: 'high' })
      const high = listGoals({ priority: 'high' })
      expect(high).toHaveLength(1)
      expect(high[0].objective).toBe('high')
    })

    it('filters by tag', () => {
      createGoal('tagged', { tags: ['bug'] })
      createGoal('untagged')
      const tagged = listGoals({ tag: 'bug' })
      expect(tagged).toHaveLength(1)
    })

    it('sorts by priority', () => {
      createGoal('low', { priority: 'low' })
      createGoal('critical', { priority: 'critical' })
      createGoal('high', { priority: 'high' })
      const sorted = listGoals()
      expect(sorted[0].priority).toBe('critical')
      expect(sorted[1].priority).toBe('high')
      expect(sorted[2].priority).toBe('low')
    })
  })

  describe('updateGoal', () => {
    it('updates objective', () => {
      const g = createGoal('old')
      const updated = updateGoal(g.id, { objective: 'new' })
      expect(updated!.objective).toBe('new')
    })

    it('updates priority', () => {
      const g = createGoal('test', { priority: 'low' })
      const updated = updateGoal(g.id, { priority: 'critical' })
      expect(updated!.priority).toBe('critical')
    })
  })

  describe('deleteGoal', () => {
    it('deletes existing goal', () => {
      const g = createGoal('test')
      expect(deleteGoal(g.id)).toBe(true)
      expect(getGoal(g.id)).toBeUndefined()
    })

    it('returns false for unknown', () => {
      expect(deleteGoal('unknown')).toBe(false)
    })
  })

  describe('subtask operations', () => {
    it('adds subtask', () => {
      const g = createGoal('test')
      const st = addSubtask(g.id, 'do something')
      expect(st).toBeDefined()
      expect(st!.description).toBe('do something')
      expect(getGoal(g.id)!.subtasks).toHaveLength(1)
    })

    it('updates subtask status', () => {
      const g = createGoal('test')
      const st = addSubtask(g.id, 'task')
      const updated = updateSubtask(g.id, st!.id, { status: 'done' })
      expect(updated!.status).toBe('done')
    })

    it('gets next pending subtask', () => {
      const g = createGoal('test')
      addSubtask(g.id, 'first')
      addSubtask(g.id, 'second')
      const next = getNextSubtask(g.id)
      expect(next!.description).toBe('first')
    })

    it('returns undefined when all done', () => {
      const g = createGoal('test')
      const st = addSubtask(g.id, 'task')
      updateSubtask(g.id, st!.id, { status: 'done' })
      expect(getNextSubtask(g.id)).toBeUndefined()
    })
  })

  describe('state transitions', () => {
    it('starts goal', () => {
      const g = createGoal('test')
      expect(startGoal(g.id)!.status).toBe('in_progress')
    })

    it('completes goal', () => {
      const g = createGoal('test')
      const completed = completeGoal(g.id)
      expect(completed!.status).toBe('completed')
      expect(completed!.completedAt).toBeDefined()
    })

    it('fails goal with reason', () => {
      const g = createGoal('test')
      const failed = failGoal(g.id, 'tests failed')
      expect(failed!.status).toBe('failed')
      expect(failed!.context.some(c => c.includes('tests failed'))).toBe(true)
    })

    it('pauses and resumes', () => {
      const g = createGoal('test')
      pauseGoal(g.id)
      expect(getGoal(g.id)!.status).toBe('paused')
      resumeGoal(g.id)
      expect(getGoal(g.id)!.status).toBe('in_progress')
    })

    it('retries failed goal', () => {
      const g = createGoal('test', { subtasks: ['task1'] })
      const st = g.subtasks[0]
      updateSubtask(g.id, st.id, { status: 'failed' })
      failGoal(g.id)
      const retried = retryGoal(g.id)
      expect(retried!.status).toBe('in_progress')
      expect(retried!.attempts).toBe(1)
      // Failed subtasks should be reset to pending
      expect(retried!.subtasks[0].status).toBe('pending')
    })

    it('does not retry beyond maxAttempts', () => {
      const g = createGoal('test', { maxAttempts: 1 })
      failGoal(g.id)
      retryGoal(g.id)
      const result = retryGoal(g.id)
      expect(result).toBeUndefined()
    })
  })

  describe('addContext', () => {
    it('adds context note', () => {
      const g = createGoal('test')
      addContext(g.id, 'learned something new')
      const updated = getGoal(g.id)
      expect(updated!.context).toHaveLength(1)
      expect(updated!.context[0]).toContain('learned something new')
    })
  })

  describe('getProgress', () => {
    it('calculates progress', () => {
      const g = createGoal('test', { subtasks: ['a', 'b', 'c', 'd'] })
      updateSubtask(g.id, g.subtasks[0].id, { status: 'done' })
      updateSubtask(g.id, g.subtasks[1].id, { status: 'done' })
      updateSubtask(g.id, g.subtasks[2].id, { status: 'in_progress' })
      updateSubtask(g.id, g.subtasks[3].id, { status: 'failed' })

      const progress = getProgress(g.id)!
      expect(progress.total).toBe(4)
      expect(progress.done).toBe(2)
      expect(progress.inProgress).toBe(1)
      expect(progress.failed).toBe(1)
      expect(progress.percentage).toBe(50)
    })

    it('handles no subtasks', () => {
      const g = createGoal('test')
      const progress = getProgress(g.id)!
      expect(progress.total).toBe(0)
      expect(progress.percentage).toBe(0)
    })
  })

  describe('formatGoal', () => {
    it('includes objective and status', () => {
      const g = createGoal('Fix bugs')
      const out = formatGoal(g)
      expect(out).toContain('Fix bugs')
      expect(out).toContain('pending')
    })

    it('includes progress bar', () => {
      const g = createGoal('test', { subtasks: ['a', 'b'] })
      updateSubtask(g.id, g.subtasks[0].id, { status: 'done' })
      const out = formatGoal(g)
      expect(out).toContain('50%')
      expect(out).toContain('1/2')
    })

    it('includes subtask list', () => {
      const g = createGoal('test', { subtasks: ['step1', 'step2'] })
      const out = formatGoal(g)
      expect(out).toContain('step1')
      expect(out).toContain('step2')
    })
  })

  describe('formatGoalList', () => {
    it('shows empty message', () => {
      const out = formatGoalList([])
      expect(out).toContain('No goals')
    })

    it('lists goals', () => {
      createGoal('first')
      createGoal('second')
      const out = formatGoalList(listGoals())
      expect(out).toContain('first')
      expect(out).toContain('second')
    })

    it('shows progress count', () => {
      const g = createGoal('test', { subtasks: ['a', 'b'] })
      updateSubtask(g.id, g.subtasks[0].id, { status: 'done' })
      const out = formatGoalList(listGoals())
      expect(out).toContain('[1/2]')
    })
  })
})

describe('goal store corruption guard', () => {
  let guardDir: string
  beforeAll(() => {
    guardDir = mkdtempSync(join(tmpdir(), 'ovolv999-goals-guard-'))
    process.env.OVOLV999_TEST_STORE_DIR = guardDir
  })
  afterAll(() => {
    rmSync(guardDir, { recursive: true, force: true })
    delete process.env.OVOLV999_TEST_STORE_DIR
  })

  it('preserves a corrupt ledger, then the next create rewrites real data', async () => {
    const path = join(guardDir, 'goals.json')
    const backup = `${path}.corrupt`
    writeFileSync(path, '{"goals": [{"id": torn', 'utf8')

    // Fresh module instance — loadStore latches `initialized` on first read.
    vi.resetModules()
    const mod = await import('../src/core/goals.js')
    expect(mod.listGoals()).toEqual([])
    expect(readFileSync(backup, 'utf8')).toBe('{"goals": [{"id": torn')

    mod.createGoal('after-crash objective')
    expect(mod.listGoals().length).toBe(1)
    expect(readFileSync(backup, 'utf8')).toBe('{"goals": [{"id": torn')
  })

  it('rejects shape-violating goals (missing objective)', async () => {
    const path = join(guardDir, 'goals.json')
    writeFileSync(path, JSON.stringify({ goals: [{ id: 'g1', status: 'pending' }] }), 'utf8')
    vi.resetModules()
    const mod = await import('../src/core/goals.js')
    expect(mod.listGoals()).toEqual([])
  })
})
