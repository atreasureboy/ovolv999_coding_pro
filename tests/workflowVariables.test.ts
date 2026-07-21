/**
 * P0-6 regression: workflow variable substitution.
 *
 * Invariant (fi_goal.md §P0-6):
 *   - ${{ inputs.X }}              → ctx.inputs[X]
 *   - ${{ steps.S.output }}        → captured stdout of prior step S
 *   - ${{ steps.S.exitCode }}      → numeric exit code
 *   - ${{ steps.S.success }}       → "true" | "false"
 *   - missing variable            → THROWS (never silent passthrough)
 *   - nested / unknown namespaces → THROWS
 *
 * Pre-fix: substituteVars was a no-op stub that emitted the literal
 * `${{ vars.X }}` placeholder verbatim into shell commands. Step
 * results were collected but never accessible.
 */

import { describe, it, expect } from 'vitest'
import {
  substituteVars,
  executeWorkflow,
  WorkflowSubstitutionError,
  type StepResult,
} from '../src/core/workflow.js'
import type { Workflow, WorkflowContext } from '../src/core/workflow.js'

// ─────────────────────────────────────────────────────────────────────
// P0-6.A: substituteVars pure-function behavior
// ─────────────────────────────────────────────────────────────────────
describe('P0-6.A: substituteVars unit behavior', () => {
  const steps: StepResult[] = [
    { name: 'build', type: 'shell', success: true, output: 'dist/', exitCode: 0, durationMs: 10 },
    { name: 'test', type: 'shell', success: false, output: '1 failed', exitCode: 2, durationMs: 20, error: 'boom' },
  ]

  it('resolves ${{ steps.S.output }}', () => {
    expect(substituteVars('out=${{ steps.build.output }}', { steps })).toBe('out=dist/')
  })

  it('resolves ${{ steps.S.exitCode }} as a string', () => {
    expect(substituteVars('exit=${{ steps.test.exitCode }}', { steps })).toBe('exit=2')
  })

  it('resolves ${{ steps.S.success }} as "true" | "false"', () => {
    expect(substituteVars('${{ steps.build.success }}|${{ steps.test.success }}', { steps })).toBe('true|false')
  })

  it('resolves ${{ steps.S.error }}', () => {
    expect(substituteVars('err=${{ steps.test.error }}', { steps })).toBe('err=boom')
  })

  it('resolves ${{ inputs.X }}', () => {
    expect(substituteVars('hi ${{ inputs.name }}', { steps: [], inputs: { name: 'world' } })).toBe('hi world')
  })

  it('THROWS on unknown step reference (no silent passthrough)', () => {
    expect(() => substituteVars('${{ steps.unknown.output }}', { steps })).toThrow(WorkflowSubstitutionError)
    expect(() => substituteVars('${{ steps.unknown.output }}', { steps })).toThrow(/unknown step/)
  })

  it('THROWS on unknown input variable', () => {
    expect(() => substituteVars('${{ inputs.missing }}', { steps: [] })).toThrow(/unknown input/)
  })

  it('THROWS on unsupported step field', () => {
    expect(() => substituteVars('${{ steps.build.bogus }}', { steps })).toThrow(/unsupported step field/)
  })

  it('THROWS on unknown namespace (vars legacy stub now surfaces)', () => {
    // Pre-fix this was a no-op that preserved the literal. The legacy
    // `${{ vars.X }}` namespace never actually substituted anything
    // (the regex returned the matched text verbatim) — now it throws
    // so operators notice the typo instead of debugging downstream.
    expect(() => substituteVars('${{ vars.foo }}', { steps: [] })).toThrow(/unknown variable namespace/)
    expect(() => substituteVars('${{ env.HOME }}', { steps: [] })).toThrow(/unknown variable namespace/)
  })

  it('returns input text unchanged when no placeholders are present', () => {
    expect(substituteVars('plain text', { steps })).toBe('plain text')
  })

  it('supports multiple placeholders in one string', () => {
    const out = substituteVars(
      '${{ steps.build.output }} then ${{ inputs.name }}',
      { steps, inputs: { name: 'X' } },
    )
    expect(out).toBe('dist/ then X')
  })

  it('handles internal whitespace in the envelope', () => {
    expect(substituteVars('${{   steps.build.output   }}', { steps })).toBe('dist/')
  })

  it('treats exitCode of an echo step (no exitCode) as empty string', () => {
    const echoStep: StepResult[] = [
      { name: 'e', type: 'echo', success: true, output: 'hi', durationMs: 0 },
    ]
    expect(substituteVars('[${{ steps.e.exitCode }}]', { steps: echoStep })).toBe('[]')
  })
})

// ─────────────────────────────────────────────────────────────────────
// P0-6.B: end-to-end executeWorkflow with serial step references
// ─────────────────────────────────────────────────────────────────────
describe('P0-6.B: executeWorkflow threads step results end-to-end', () => {
  function makeCtx(overrides: Partial<WorkflowContext> = {}): WorkflowContext {
    return {
      cwd: process.cwd(),
      runSlash: async (cmd: string) => `slash(${cmd})`,
      promptUser: async () => 'p',
      runAgent: async (prompt: string) => `agent(${prompt})`,
      ...overrides,
    }
  }

  it('shell step B sees the output of shell step A', async () => {
    const wf: Workflow = {
      name: 'serial-chain',
      steps: [
        { name: 'a', type: 'shell', command: 'echo AAA' },
        { name: 'b', type: 'shell', command: 'echo "got ${{ steps.a.output }}"' },
      ],
    }
    const result = await executeWorkflow(wf, makeCtx())
    expect(result.success).toBe(true)
    expect(result.steps[1]?.output).toBe('got AAA')
  })

  it('echo step sees prior shell step output', async () => {
    const wf: Workflow = {
      name: 'echo-chain',
      steps: [
        { name: 'src', type: 'shell', command: 'echo hello' },
        { name: 'snap', type: 'echo', text: 'echoed=${{ steps.src.output }}' },
      ],
    }
    const result = await executeWorkflow(wf, makeCtx())
    expect(result.steps[1]?.output).toBe('echoed=hello')
  })

  it('agent step receives substituted prompt referencing prior step output', async () => {
    const wf: Workflow = {
      name: 'agent-chain',
      steps: [
        { name: 'probe', type: 'shell', command: 'echo probe-result' },
        { name: 'work', type: 'agent', prompt: 'investigate ${{ steps.probe.output }}' },
      ],
    }
    const result = await executeWorkflow(wf, makeCtx())
    expect(result.steps[1]?.output).toBe('agent(investigate probe-result)')
  })

  it('inputs passed via WorkflowContext are visible to steps', async () => {
    const wf: Workflow = {
      name: 'inputs-wf',
      steps: [
        { name: 'use', type: 'echo', text: 'hello ${{ inputs.who }}' },
      ],
    }
    const result = await executeWorkflow(wf, makeCtx({ inputs: { who: 'world' } }))
    expect(result.steps[0]?.output).toBe('hello world')
  })

  it('unknown input reference fails the step (not the whole workflow by default)', async () => {
    const wf: Workflow = {
      name: 'missing-input',
      steps: [
        { name: 'broken', type: 'echo', text: 'hi ${{ inputs.unknown }}' },
      ],
    }
    const result = await executeWorkflow(wf, makeCtx())
    expect(result.steps[0]?.success).toBe(false)
    expect(result.steps[0]?.error).toMatch(/unknown input/)
  })

  it('failure-branch step can read the prior failure exitCode', async () => {
    const wf: Workflow = {
      name: 'fail-branch',
      steps: [
        { name: 'fail', type: 'shell', command: 'exit 7', continueOnError: true },
        { name: 'recover', type: 'shell', command: 'echo "recovered from ${{ steps.fail.exitCode }}"', if: 'failure' },
      ],
    }
    const result = await executeWorkflow(wf, makeCtx())
    expect(result.steps[1]?.output).toBe('recovered from 7')
  })
})
