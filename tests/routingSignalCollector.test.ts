/**
 * v0.3.1 RoutingSignalCollector (te_goal §三.1.3).
 *
 * Verifies that the collector produces a complete RoutingSignals
 * snapshot for each te_goal-bullet:
 *   - architecture decision combines keyword + task-graph evidence
 *   - expected tool requirement classifies read-only vs side-effect
 *   - public-interface / cross-module / config-change signals surface
 *     from goal text + task graph
 *   - repoFileCount + estimatedImpactFiles + taskGraphScale propagate
 *   - signalsToRoutingInput produces a RoutingInput the Router consumes
 */
import { describe, it, expect } from 'vitest'
import {
  collectRoutingSignals,
  signalsToRoutingInput,
} from '../src/core/model/routingSignalCollector.js'

describe('RoutingSignalCollector v0.3.1', () => {
  it('produces a complete signal snapshot for an architecture goal', () => {
    const s = collectRoutingSignals({
      userMessage: 'Refactor the core architecture and migrate the schema',
      workingState: {
        filesRead: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
        filesChanged: [],
        verification: { passed: [], failed: [] },
        unresolved: [],
      },
    })
    expect(s.userGoal).toContain('Refactor')
    expect(s.filesTouched).toBe(3)
    expect(s.needsArchitecture).toBe(true)
    expect(s.isConfigChange).toBe(true) // "schema" matches CONFIG_CHANGE_KEYWORDS
    expect(s.expectedToolRequirement).toBe('mixed')
  })

  it('detects side-effect tool requirement when files are already changed', () => {
    const s = collectRoutingSignals({
      userMessage: 'finish the work',
      workingState: {
        filesRead: [],
        filesChanged: ['src/x.ts'],
        verification: { passed: [], failed: [] },
        unresolved: [],
      },
    })
    expect(s.expectedToolRequirement).toBe('side-effect')
  })

  it('detects root-cause goal via keyword', () => {
    const s = collectRoutingSignals({
      userMessage: 'Why does this test fail with a NullPointerException?',
    })
    expect(s.requiresRootCause).toBe(true)
    expect(s.needsArchitecture).toBe(false) // not architecture, just debugging
  })

  it('combines keyword + task-graph evidence for needsArchitecture', () => {
    // keyword alone is not architecture; add task-graph evidence → true
    const s = collectRoutingSignals({
      userMessage: 'fix the broken thing',
      taskGraph: {
        nodeCount: 3,
        preferredRoles: [],
        hasConfigChanges: true,
        hasCrossModuleEdits: false,
        hasPublicInterfaceEdits: false,
        hasRootCauseNode: false,
      },
    })
    expect(s.isConfigChange).toBe(true)
    expect(s.needsArchitecture).toBe(true)
  })

  it('flags affectsPublicInterface from public-interface keyword', () => {
    const s = collectRoutingSignals({
      userMessage: 'Add a new public api signature',
    })
    expect(s.affectsPublicInterface).toBe(true)
  })

  it('flags isCrossModule from cross-module keyword', () => {
    const s = collectRoutingSignals({
      userMessage: 'Wire up cross-module integration boundary',
    })
    expect(s.isCrossModule).toBe(true)
  })

  it('estimates impact files from working state and goal length', () => {
    const small = collectRoutingSignals({
      userMessage: 'list files',
      workingState: {
        filesRead: ['a.ts'], filesChanged: [], verification: { passed: [], failed: [] }, unresolved: [],
      },
    })
    expect(small.estimatedImpactFiles).toBeGreaterThanOrEqual(0)
    const big = collectRoutingSignals({
      userMessage: 'Implement a comprehensive redesign across the entire codebase with new modules and significant schema changes',
      workingState: {
        filesRead: Array.from({ length: 20 }, (_, i) => `f${i}.ts`),
        filesChanged: ['a.ts', 'b.ts'],
        verification: { passed: [], failed: [] },
        unresolved: [],
      },
    })
    expect(big.estimatedImpactFiles).toBeGreaterThan(small.estimatedImpactFiles)
    expect(big.filesTouched).toBe(22)
    expect(big.needsArchitecture).toBe(true)
  })

  it('captures providerHealth from routerHealth input', () => {
    const s = collectRoutingSignals({
      userMessage: 'x',
      routerHealth: {
        providerHealth: [
          { profileId: 'a', failRate: 0.1, avgLatencyMs: 200 },
          { profileId: 'b', failRate: 0.7, avgLatencyMs: 800 },
        ],
        previousRoutingFailures: 3,
      },
    })
    expect(s.providerHealth.length).toBe(2)
    expect(s.previousRoutingFailures).toBe(3)
  })

  it('emits a preferred role from the task graph when present', () => {
    const s = collectRoutingSignals({
      userMessage: 'x',
      taskGraph: {
        nodeCount: 2,
        preferredRoles: ['worker', 'cheap'],
        hasConfigChanges: false,
        hasCrossModuleEdits: false,
        hasPublicInterfaceEdits: false,
        hasRootCauseNode: false,
      },
    })
    expect(s.role).toBe('worker')
    expect(s.taskGraphScale).toBe(2)
  })

  it('signalsToRoutingInput produces a Router-consumable RoutingInput', () => {
    const s = collectRoutingSignals({
      userMessage: 'Redesign the API with breaking change',
    })
    const input = signalsToRoutingInput(s)
    expect(input.userGoal).toBe(s.userGoal)
    expect(input.needsArchitecture).toBe(s.needsArchitecture)
    expect(input.consecutiveFailures).toBe(s.recentFailureCount + s.previousRoutingFailures)
    expect(input.contextUsageRatio).toBe(s.contextUsageRatio)
    expect(input.budgetRemaining).toBe(s.budgetRemaining)
    expect(input.role).toBe(s.role)
  })

  it('defaults are sane when no inputs provided', () => {
    const s = collectRoutingSignals({ userMessage: 'hello' })
    expect(s.filesTouched).toBe(0)
    expect(s.recentFailureCount).toBe(0)
    expect(s.budgetRemaining).toBe(1)
    expect(s.contextUsageRatio).toBe(0)
    expect(s.providerHealth).toEqual([])
    expect(s.previousRoutingFailures).toBe(0)
    expect(s.taskGraphScale).toBe(0)
    expect(s.expectedToolRequirement).toBe('read-only') // short generic greeting under 80 chars
  })
})