/**
 * Phase 6 (five_goal §十 P1-6, P1-7):
 *
 * P1-6: WorkingState wired into ContextManager — no longer standalone.
 *       Tool events update the state deterministically (Read → filesRead,
 *       Edit/Write → filesChanged, Bash exit → verification.passed/failed
 *       + unresolved). The model never gets to freely overwrite state.
 *
 * P1-7: Context assembly — WorkingState rendered into system prompt via
 *       renderWorkingStateBlock(). Lives outside the message log so
 *       compaction cannot silently drop constraints/facts/unresolved
 *       (invariants INV-1..INV-5).
 */

import { describe, it, expect } from 'vitest'
import { ContextManager } from '../src/core/context/contextManager.js'
import {
  emptyWorkingState,
  addConstraint,
  addFact,
  type WorkingState,
} from '../src/core/workingState.js'

// ── Harness ─────────────────────────────────────────────────────────────

function fakeOpenAIClient(): unknown {
  return { chat: { completions: { create: async () => ({ choices: [{ message: { content: '' } }] }) } } }
}

function fakeRenderer(): unknown {
  const r: Record<string, unknown> = {}
  for (const k of [
    'banner', 'info', 'warn', 'error', 'success',
    'startSpinner', 'stopSpinner',
    'beginAssistantText', 'endAssistantText', 'streamToken',
    'toolStart', 'toolResult',
    'compactStart', 'compactDone', 'contextWarning',
    'agentStart', 'agentDone', 'agentSummary', 'agentHeartbeat',
  ]) {
    r[k] = (..._a: unknown[]) => undefined
  }
  return r
}

function makeContextManager(): ContextManager {
  return new ContextManager({
    client: fakeOpenAIClient() as never,
    model: 'm',
    renderer: fakeRenderer() as never,
  })
}

// ─────────────────────────────────────────────────────────────────────
// P1-6: deterministic state updates from tool events
// ─────────────────────────────────────────────────────────────────────
describe('P1-6: applyToolEvent updates WorkingState deterministically', () => {
  it('Read success → filesRead += path', () => {
    const cm = makeContextManager()
    cm.applyToolEvent({
      toolName: 'Read',
      input: { file_path: '/abs/src/engine.ts' },
      result: { isError: false, content: '...' },
    })
    expect(cm.getWorkingState().filesRead).toContain('/abs/src/engine.ts')
  })

  it('Edit success → filesChanged += path', () => {
    const cm = makeContextManager()
    cm.applyToolEvent({
      toolName: 'Edit',
      input: { file_path: '/abs/src/types.ts' },
      result: { isError: false, content: '...' },
    })
    expect(cm.getWorkingState().filesChanged).toContain('/abs/src/types.ts')
    // And NOT in filesRead — these are distinct sets.
    expect(cm.getWorkingState().filesRead).not.toContain('/abs/src/types.ts')
  })

  it('Write success → filesChanged += path', () => {
    const cm = makeContextManager()
    cm.applyToolEvent({
      toolName: 'Write',
      input: { file_path: '/abs/new-file.ts' },
      result: { isError: false, content: '...' },
    })
    expect(cm.getWorkingState().filesChanged).toContain('/abs/new-file.ts')
  })

  it('Bash exit 0 → verification.passed', () => {
    const cm = makeContextManager()
    cm.applyToolEvent({
      toolName: 'Bash',
      input: { command: 'npm test' },
      result: { isError: false, exitCode: 0, content: '...' },
    })
    const v = cm.getWorkingState().verification
    expect(v.passed).toContain('npm test')
    expect(v.failed).not.toContain('npm test')
  })

  it('Bash non-zero → verification.failed + unresolved', () => {
    const cm = makeContextManager()
    cm.applyToolEvent({
      toolName: 'Bash',
      input: { command: 'npm test' },
      result: { isError: true, exitCode: 1, content: 'fail' },
    })
    const s = cm.getWorkingState()
    expect(s.verification.failed).toContain('npm test')
    expect(s.verification.passed).not.toContain('npm test')
    // five_goal §十: 测试失败 → unresolved 添加失败摘要
    expect(s.unresolved.some(u => u.includes('npm test'))).toBe(true)
  })

  it('Bash previously failed, now passing — resolves the unresolved entry', () => {
    const cm = makeContextManager()
    cm.applyToolEvent({
      toolName: 'Bash',
      input: { command: 'npm test' },
      result: { isError: true, exitCode: 1, content: 'fail' },
    })
    expect(cm.getWorkingState().unresolved.length).toBe(1)

    cm.applyToolEvent({
      toolName: 'Bash',
      input: { command: 'npm test' },
      result: { isError: false, exitCode: 0, content: 'ok' },
    })
    const s = cm.getWorkingState()
    expect(s.verification.passed).toContain('npm test')
    expect(s.verification.failed).not.toContain('npm test')
    // Resolved entries drop out of unresolved.
    expect(s.unresolved.some(u => u.includes('npm test'))).toBe(false)
  })

  it('Read failure does NOT mutate filesRead', () => {
    const cm = makeContextManager()
    cm.applyToolEvent({
      toolName: 'Read',
      input: { file_path: '/missing.txt' },
      result: { isError: true, content: 'not found' },
    })
    expect(cm.getWorkingState().filesRead).not.toContain('/missing.txt')
  })

  it('unknown tool is a no-op', () => {
    const cm = makeContextManager()
    const before = cm.getWorkingState()
    cm.applyToolEvent({
      toolName: 'MysteryTool',
      input: {},
      result: { isError: false, content: '' },
    })
    expect(cm.getWorkingState()).toEqual(before)
  })

  it('state is replaced immutably (earlier snapshots remain stable)', () => {
    const cm = makeContextManager()
    const snapshot = cm.getWorkingState()
    cm.applyToolEvent({
      toolName: 'Read',
      input: { file_path: '/a' },
      result: { isError: false, content: '' },
    })
    // snapshot is unchanged.
    expect(snapshot.filesRead).toEqual([])
    // Live state reflects the update.
    expect(cm.getWorkingState().filesRead).toContain('/a')
  })
})

// ─────────────────────────────────────────────────────────────────────
// P1-7: renderWorkingStateBlock produces stable system-prompt text
// ─────────────────────────────────────────────────────────────────────
describe('P1-7: renderWorkingStateBlock produces stable output', () => {
  it('empty state renders NO text (five_goal §四: no injection when empty)', () => {
    const cm = makeContextManager()
    const out = cm.renderWorkingStateBlock()
    expect(out).toBe('')
  })

  it('constraints appear in the rendered block', () => {
    const cm = makeContextManager()
    cm.setWorkingState(addConstraint(cm.getWorkingState(), 'no breaking changes'))
    const out = cm.renderWorkingStateBlock()
    expect(out).toMatch(/no breaking changes/)
  })

  it('confirmedFacts appear in the rendered block', () => {
    const cm = makeContextManager()
    cm.setWorkingState(addFact(cm.getWorkingState(), { claim: 'engine uses ESM', source: 'engine.ts' }))
    const out = cm.renderWorkingStateBlock()
    expect(out).toMatch(/engine uses ESM/)
    expect(out).toMatch(/engine\.ts/)
  })

  it('filesChanged appear in the rendered block (INV-3)', () => {
    const cm = makeContextManager()
    cm.applyToolEvent({
      toolName: 'Write',
      input: { file_path: '/abs/edited.ts' },
      result: { isError: false, content: '' },
    })
    const out = cm.renderWorkingStateBlock()
    expect(out).toMatch(/edited\.ts/)
  })

  it('verification.failed appears in the rendered block (INV-4)', () => {
    const cm = makeContextManager()
    cm.applyToolEvent({
      toolName: 'Bash',
      input: { command: 'npm test' },
      result: { isError: true, exitCode: 1, content: '' },
    })
    const out = cm.renderWorkingStateBlock()
    expect(out).toMatch(/npm test/)
  })

  it('unresolved items appear in the rendered block (INV-5)', () => {
    const cm = makeContextManager()
    cm.applyToolEvent({
      toolName: 'Bash',
      input: { command: 'risky cmd' },
      result: { isError: true, exitCode: 2, content: '' },
    })
    const out = cm.renderWorkingStateBlock()
    expect(out).toMatch(/risky cmd/)
  })
})
