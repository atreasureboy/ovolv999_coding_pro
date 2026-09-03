/**
 * Question-shaped messages ("how do I configure the linter?", "explain how
 * the build pipeline works") hit mutation keywords by noun usage ("build",
 * "update", "fix") and were classified MUTATION — so the completion gate
 * demanded workspace changes and the loop fired the premature-handoff
 * continuation ("stopped without producing the requested workspace change")
 * up to three times, for a question. isInterrogativeLead suppresses that at
 * all three enforcement sites: classifyTaskIntent, the analysis verification
 * nudge in detectPrematureHandoff, and the coordinator's
 * execution-verification criterion.
 */
import { describe, it, expect } from 'vitest'
import OpenAI from 'openai'
import { classifyTaskIntent, isInterrogativeLead } from '../src/core/runtime/taskIntent.js'
import { detectPrematureHandoff } from '../src/core/runtime/prematureHandoff.js'
import { ExecutionEngine } from '../src/core/engine.js'

describe('isInterrogativeLead', () => {
  it('matches English question shapes', () => {
    expect(isInterrogativeLead('how do I configure the linter?')).toBe(true)
    expect(isInterrogativeLead('what does the update script do?')).toBe(true)
    expect(isInterrogativeLead('explain how the build pipeline works')).toBe(true)
    expect(isInterrogativeLead('tell me where the retry logic lives')).toBe(true)
    expect(isInterrogativeLead('whether to migrate is still open')).toBe(true)
  })

  it('does not match imperatives or Chinese how-words', () => {
    expect(isInterrogativeLead('fix the login bug')).toBe(false)
    expect(isInterrogativeLead('update the config to enable sourcemaps')).toBe(false)
    expect(isInterrogativeLead('怎么修复登录bug')).toBe(false)
  })
})

describe('classifyTaskIntent question suppression', () => {
  it('question-shaped keyword hits are informational, not mutation', () => {
    expect(classifyTaskIntent('how do I configure the linter?', {}).kind).toBe('informational')
    // 'explain' is itself an analysis keyword — analysis is the correct
    // deep-read classification; the defect was MUTATION (change demands).
    expect(classifyTaskIntent('explain how the build pipeline works', {}).kind).toBe('analysis')
    expect(classifyTaskIntent('what does the update script do?', {}).kind).toBe('informational')
    expect(classifyTaskIntent('how do I fix the login bug?', {}).kind).toBe('informational')
  })

  it('imperatives still classify mutation', () => {
    expect(classifyTaskIntent('fix the login bug', {}).kind).toBe('mutation')
    expect(classifyTaskIntent('configure the linter for strict mode', {}).kind).toBe('mutation')
    expect(classifyTaskIntent('怎么修复登录bug', {}).kind).toBe('mutation')
  })

  it('a mutation connector after the question re-fires mutation', () => {
    expect(classifyTaskIntent('explain how the build works and then fix it', {}).kind).toBe('mutation')
  })
})

describe('detectPrematureHandoff question suppression', () => {
  it('an analysis question is not nudged to run commands', () => {
    const intent = classifyTaskIntent('explain what the lint check does', {})
    const d = detectPrematureHandoff({
      assistantText: 'The lint check runs eslint across src/ and fails on warnings.',
      intent,
      filesRead: 0,
      filesChanged: 0,
      verificationCount: 0,
    })
    expect(d.continue).toBe(false)
  })

  it('an analysis task with a real execution request is still nudged', () => {
    const intent = classifyTaskIntent('check whether the project typechecks', {})
    expect(intent.kind).toBe('analysis')
    expect(isInterrogativeLead('check whether the project typechecks')).toBe(false)
    const d = detectPrematureHandoff({
      assistantText: 'I looked at the tsconfig and it should be fine.',
      intent,
      filesRead: 5,
      filesChanged: 0,
      verificationCount: 0,
    })
    expect(d.continue).toBe(true)
    expect(d.reason).toContain('verification command')
  })
})

describe('end-to-end: a how-to question completes without changes', () => {
  it('the engine does not block a question for missing file changes', async () => {
    const calls: Array<{ params: { stream?: boolean } }> = []
    const client = {
      chat: {
        completions: {
          create: async (params: { stream?: boolean } & Record<string, unknown>) => {
            calls.push({ params })
            if (params.stream === true) {
              const chunks = [
                { choices: [{ delta: { role: 'assistant' }, index: 0 }] },
                { choices: [{ delta: { content: 'Set strict: true in the compilerOptions of your tsconfig.json.' }, index: 0 }] },
              ]
              return {
                [Symbol.asyncIterator]: () => {
                  let i = 0
                  return {
                    next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined as never, done: true }),
                  }
                },
              }
            }
            return { choices: [{ message: { role: 'assistant', content: 'summary' } }] }
          },
        },
      },
    }
    const engine = new ExecutionEngine({
      apiKey: 'test',
      model: 'gpt-4o',
      baseURL: 'https://api.example.com/v1',
      maxIterations: 5,
      cwd: '/tmp',
      permissionMode: 'bypassPermissions',
      enabledModules: [],
    } as never, {
      info: () => {}, warn: () => {}, error: () => {},
      success: () => {}, banner: () => {},
      startSpinner: () => {}, stopSpinner: () => {},
      beginAssistantText: () => {}, endAssistantText: () => {},
      streamToken: () => {}, toolStart: () => {}, toolResult: () => {},
      compactStart: () => {}, compactDone: () => {}, contextWarning: () => {},
    } as never, client as unknown as OpenAI)
    const t = await engine.runTurn('how do I configure the linter?', [])
    expect(t.result.reason).toBe('stop_sequence')
    expect(t.outcome.completion.status).toBe('completed')
    expect(t.outcome.completion.reasons).toEqual([])
  })
})
