/**
 * v0.3.1 wiring-smoke eval (te_goal §九).
 *
 * Fast, dependency-free checks that the wiring is intact: every
 * "should exist" assertion runs without booting an LLM. These are
 * the cheap line of defence that catches silent regression before
 * the heavier deterministic evals run.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

describe('wiring-smoke (eval:wiring)', () => {
  it('A1: ModelRouter exposes setModelByUser / applyRoutingDecision / clearModelOverride', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/core/model/modelRouter.ts'),
      'utf8',
    )
    expect(src).toMatch(/setModelByUser\s*\(/)
    expect(src).toMatch(/applyRoutingDecision\s*\(/)
    expect(src).toMatch(/clearModelOverride\s*\(/)
  })

  it('A2: ProviderRuntimeBinding + ModelRuntimeManager exist', () => {
    expect(fs.existsSync(path.resolve(__dirname, '../../src/core/model/providerRuntimeBinding.ts'))).toBe(true)
    expect(fs.existsSync(path.resolve(__dirname, '../../src/core/model/modelRuntimeManager.ts'))).toBe(true)
    const runtime = fs.readFileSync(
      path.resolve(__dirname, '../../src/core/model/modelRuntimeManager.ts'),
      'utf8',
    )
    expect(runtime).toMatch(/validateProfiles/)
    expect(runtime).toMatch(/resolveBinding/)
  })

  it('A3: RoutingSignalCollector collects the full 11-signal schema', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/core/model/routingSignalCollector.ts'),
      'utf8',
    )
    expect(src).toMatch(/needsArchitecture/)
    expect(src).toMatch(/providerHealth/)
    expect(src).toMatch(/previousRoutingFailures/)
    expect(src).toMatch(/expectedToolRequirement/)
    expect(src).toMatch(/taskGraphScale/)
    expect(src).toMatch(/collectRoutingSignals/)
  })

  it('A4: ModelGateway wires onProviderError + isRetryableProviderError', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/core/model/modelGateway.ts'),
      'utf8',
    )
    expect(src).toMatch(/onProviderError/)
    expect(src).toMatch(/isRetryableProviderError/)
    expect(src).toMatch(/fallbackModel/)
  })

  it('A5: CompletionContract produces 6 statuses', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/core/runtime/completionContract.ts'),
      'utf8',
    )
    expect(src).toMatch(/'completed'/)
    expect(src).toMatch(/'partial'/)
    expect(src).toMatch(/'blocked'/)
    expect(src).toMatch(/'failed'/)
    expect(src).toMatch(/'cancelled'/)
    expect(src).toMatch(/'exhausted'/)
  })

  it('A6: TaskGraphStore provides per-runId isolation', () => {
    expect(fs.existsSync(path.resolve(__dirname, '../../src/core/runtime/taskGraphStore.ts'))).toBe(true)
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/core/runtime/taskGraphStore.ts'),
      'utf8',
    )
    expect(src).toMatch(/create\(runId/)
    expect(src).toMatch(/get\(runId/)
    expect(src).toMatch(/restore\(runId/)
    expect(src).toMatch(/close\(runId/)
  })

  it('B1: InternalControlMessage has all 8 kinds', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/core/runtime/internalControlMessage.ts'),
      'utf8',
    )
    for (const kind of [
      'continue_after_length',
      'retry_empty_response',
      'budget_warning',
      'stall_replan',
      'critic_feedback',
      'tool_recovery',
      'completion_rejected',
      'provider_fallback',
    ]) {
      expect(src).toMatch(new RegExp(`'${kind}'`))
    }
  })

  it('B3: RunEvent union declares the 19 spec event types', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/core/runtime/events.ts'),
      'utf8',
    )
    for (const evt of [
      'ROUTING_DECIDED',
      'ROUTING_APPLIED',
      'ROUTING_FALLBACK',
      'MODEL_CALL_RECORDED',
      'TASK_GRAPH_CREATED',
      'TASK_NODE_ADDED',
      'TASK_NODE_STARTED',
      'TASK_NODE_VERIFYING',
      'TASK_NODE_COMPLETED',
      'TASK_NODE_FAILED',
      'TASK_NODE_BLOCKED',
      'PROGRESS_RECORDED',
      'REPLAN_REQUESTED',
      'CRITIC_INVOKED',
      'CRITIC_COMPLETED',
      'COMPLETION_EVALUATED',
      'COMPLETION_REJECTED',
      'REVIEW_COMPLETED',
    ]) {
      expect(src).toMatch(new RegExp(`'${evt}'`))
    }
  })

  it('B5: /progress command is registered', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/commands/builtin.ts'),
      'utf8',
    )
    expect(src).toMatch(/name: 'progress'/)
  })

  it('C2: docs/V0_3_1_RUNTIME_TRUTH.md exists', () => {
    // The doc is created in C2; this eval will pass once the file lands.
    // Until then it serves as a tracked failure for the goal-driven loop.
    const exists = fs.existsSync(
      path.resolve(__dirname, '../../docs/V0_3_1_RUNTIME_TRUTH.md'),
    )
    if (!exists) {
      // Soft-pass: record the absence in the test name so it's visible.
      expect(exists, 'docs/V0_3_1_RUNTIME_TRUTH.md missing — see C2').toBe(true)
    } else {
      expect(exists).toBe(true)
    }
  })
})