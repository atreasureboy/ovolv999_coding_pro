/**
 * v0.4.1 WS6 — one output spec. The assembled system prompt must carry
 * exactly ONE output contract: direct Q&A + one structured outcome report
 * for coding tasks (fields mirror the UI outcome card). The contradictory
 * "1-3 sentences / one word if sufficient" brevity caps are gone, and the
 * third parallel brevity system (/style + outputStyles.ts) is deleted.
 */
import { describe, it, expect } from 'vitest'
import { getSystemPrompt } from '../src/prompts/system.js'

describe('system prompt — one output spec, no over-brevity', () => {
  const prompt = getSystemPrompt('/tmp/project')

  it('contains no brevity caps anywhere in the assembled prompt', () => {
    expect(prompt).not.toContain('1-3 sentences')
    expect(prompt).not.toContain('one word if sufficient')
    expect(prompt).not.toContain('keep it short')
    expect(prompt).not.toContain('one concise outcome report')
  })

  it('has exactly one structured outcome-report spec mirroring the outcome card', () => {
    expect(prompt).toContain('# Outcome Reporting')
    expect(prompt).toContain('**Changes**')
    expect(prompt).toContain('**Verification**')
    expect(prompt).toContain('**Unresolved**')
    expect(prompt).toContain('**Next actions**')
    expect(prompt).toContain('Omit empty sections')
  })

  it('pure Q&A answers directly — no report block demanded', () => {
    expect(prompt).toMatch(/pure Q&A/)
  })

  it('keeps the general PREFER/AVOID nudges (guidance, not caps)', () => {
    expect(prompt).toContain('PREFER batched independent reads')
    expect(prompt).toContain('AVOID unnecessary narration')
  })

  it('interrupt copy is frontend-agnostic (no false feedback-injection promise)', () => {
    expect(prompt).not.toContain('inject guidance')
    expect(prompt).toContain('ESC')
  })
})

describe('system prompt — /style removed (third parallel brevity system)', () => {
  it('command registry has neither /style nor /output-style', async () => {
    await import('../src/commands/builtin.js')
    const { getCommand, listCommands } = await import('../src/commands/index.js')
    expect(getCommand('style')).toBeUndefined()
    expect(getCommand('output-style')).toBeUndefined()
    expect(listCommands().some((c) => c.name === 'style')).toBe(false)
  })
})

describe('system prompt — runtime permission and critic truth', () => {
  it('describes the active permission mode without claiming fixed full access', () => {
    const safe = getSystemPrompt('/tmp/project', undefined, undefined, undefined, 'default')
    const autonomous = getSystemPrompt('/tmp/project', undefined, undefined, undefined, 'auto')
    expect(safe).toContain('Current runtime permission mode: **default**')
    expect(autonomous).toContain('Current runtime permission mode: **auto**')
    expect(safe).not.toContain('FULL ACCESS')
    expect(autonomous).not.toContain('FULL ACCESS')
  })

  it('describes critic triggers and cancellation without pause/resume claims', () => {
    const prompt = getSystemPrompt('/tmp/project')
    expect(prompt).toContain('triggered by risk, stalled progress, repeated errors')
    expect(prompt).not.toContain('runs every few iterations')
    expect(prompt).toContain('do not describe this as pause/resume')
  })
})

describe('system prompt — role-aware delegation truth', () => {
  const prompt = getSystemPrompt('/tmp/project')

  it('requires capability roles, structured context, and parent-owned acceptance', () => {
    expect(prompt).toContain('Use model_role only as a capability request')
    expect(prompt).toContain('delegation_context')
    expect(prompt).toContain('Embedding profiles are reserved for retrieval integrations, not autonomous agents')
    expect(prompt).toContain('The Worker Result is evidence, not authority')
  })
})
