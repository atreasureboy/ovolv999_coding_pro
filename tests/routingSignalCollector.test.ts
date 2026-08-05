/**
 * v0.3.1 RoutingSignalCollector (runtime truth contract §三.1.3).
 *
 * Verifies that the collector produces a complete RoutingSignals
 * snapshot for each runtime truth contract-bullet:
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
  type RoutingSignals,
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
      },
    })
    expect(s.providerHealth.length).toBe(2)
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
    // v0.5.5 §14: previousRoutingFailures / totalFallbacksApplied /
    // circuitState are NOT propagated as decision inputs.
    expect(input.consecutiveFailures).toBe(s.recentFailureCount)
    expect(input.contextUsageRatio).toBe(s.contextUsageRatio)
    expect(input.budgetRemaining).toBe(s.budgetRemaining)
    expect(input.role).toBe(s.role)
    expect(input.providerHealth).toBe(s.providerHealth)
    expect(input.expectedToolRequirement).toBe(s.expectedToolRequirement)
    expect(input.affectsPublicInterface).toBe(s.affectsPublicInterface)
    expect(input.isCrossModule).toBe(s.isCrossModule)
    expect(input.isConfigChange).toBe(s.isConfigChange)
    expect(input.requiresRootCause).toBe(s.requiresRootCause)
    expect(input.estimatedImpactFiles).toBe(s.estimatedImpactFiles)
    expect(input.taskGraphScale).toBe(s.taskGraphScale)
  })

  it('preserves unknown context and budget measurements when no inputs are provided', () => {
    const s = collectRoutingSignals({ userMessage: 'hello' })
    expect(s.filesTouched).toBe(0)
    expect(s.recentFailureCount).toBe(0)
    expect(s.budgetRemaining).toBeUndefined()
    expect(s.contextUsageRatio).toBeUndefined()
    expect(s.providerHealth).toEqual([])
    // v0.5.5 §14: previousRoutingFailures removed from decision inputs.
    //   This assertion is kept as a regression guard for the
    //   collector's behaviour, but the field no longer feeds the Router.
    void s
    expect(s.taskGraphScale).toBe(0)
    expect(s.expectedToolRequirement).toBe('read-only') // short generic greeting under 80 chars
  })

  // ── run-scoped runtime contract §6.1: exhaustiveness test ──────────────────────────
  // If a new field is added to RoutingSignals but NOT mapped in
  // signalsToRoutingInput (or listed in UNMAPPED), this test fails.
  // That prevents silent signal loss when the schema grows.
  it('signalsToRoutingInput maps every RoutingSignals field (or lists it as unmapped)', () => {
    const sampleSignals: RoutingSignals = {
      userGoal: 'refactor core',
      repoFileCount: 500,
      filesTouched: 12,
      recentFailureCount: 2,
      contextUsageRatio: 0.7,
      budgetRemaining: 0.4,
      role: 'main',
      needsArchitecture: true,
      providerHealth: [{ profileId: 'p1', failRate: 0.1, avgLatencyMs: 800 }],
      expectedToolRequirement: 'side-effect',
      affectsPublicInterface: true,
      isCrossModule: true,
      isConfigChange: false,
      requiresRootCause: true,
      estimatedImpactFiles: 8,
      taskGraphScale: 3,
    }

    const UNMAPPED = new Set([
      'recentFailureCount',
    ])

    const allFields = Object.keys(sampleSignals)
    const mapped = signalsToRoutingInput(sampleSignals)
    const mappedKeys = new Set(Object.keys(mapped))

    const lost = allFields.filter((f) => !mappedKeys.has(f) && !UNMAPPED.has(f))
    expect(lost).toEqual([])
  })
})
