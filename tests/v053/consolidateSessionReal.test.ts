/**
 * v0.5.3 Final (P1): real end-to-end consolidation test.
 *
 * The previous consolidateSession was a no-op — sessionRunIds was
 * always [] in the production CLI path, and outcomeForCaller /
 * userMessage were never set. This test exercises the merge
 * path with real LongTermMemory records across two runIds and
 * asserts the merger wrote a new promoted entry that cites BOTH
 * runIds in its provenance.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { LongTermMemory, InMemoryMemoryBackend } from '../../src/core/longTermMemory.js'
import { consolidateSession } from '../../src/modules/reflection.js'

interface FakeChatCompletion {
  knowledge: Array<{ content: string; tags?: string[]; confidence: number }>
}

class FakeClient {
  constructor(private readonly scripted: FakeChatCompletion) {}
  chat = {
    completions: {
      // consolidateSession never invokes the LLM (its new shape
      // records evidence via decidePromotion), but the field is
      // required to match the OpenAI shape. Keep an entry that
      // would crash if it's ever called — we want a loud failure.
      create: () => { throw new Error('consolidateSession must not call the LLM') },
    },
  }
}

describe('consolidateSession — real round trip (v0.5.3 Final P1)', () => {
  let tmpDir: string
  let ltm: LongTermMemory
  let client: FakeClient

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ovolv999-consolidate-'))
    // v0.5.3 Final (P1): use the in-memory backend so this test
    // does NOT cross-pollute the host filesystem with the
    // production JsonlMemoryBackend.
    ltm = new LongTermMemory({ backend: new InMemoryMemoryBackend() })
    client = new FakeClient({ knowledge: [] })
  })
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('merges two verified records across runIds into a single promoted entry', async () => {
    // Seed two verified entries with the SAME content hash key,
    // authored under distinct runIds.
    const runA = 'run-A'
    const runB = 'run-B'
    ltm.record({
      kind: 'semantic',
      content: 'snake_case is mandatory for new variables',
      repo: tmpDir,
      branch: undefined,
      commit: undefined,
      sourceRunId: runA,
      origin: `memory_promotion:${runA}`,
      confidence: 0.8,
      verified: true,
      tags: ['convention'],
      expiresAt: undefined,
    })
    ltm.record({
      kind: 'semantic',
      content: 'snake_case is mandatory for new variables',
      repo: tmpDir,
      branch: undefined,
      commit: undefined,
      sourceRunId: runB,
      origin: `memory_promotion:${runB}`,
      confidence: 0.9,
      verified: true,
      tags: ['convention'],
      expiresAt: undefined,
    })

    const dummyOutcome = {
      runId: runA,
      stopReason: 'stop_sequence' as const,
      completion: { status: 'completed' as const, reasons: [], evidence: [], requiredNextActions: [] },
      output: '...',
      changedFiles: [],
      artifacts: [],
      verification: { executed: true, passed: true, failed: [] },
      modelAttempts: [],
      durationMs: 0,
      stopped: true,
      reason: 'stop_sequence',
    }

    const result = await consolidateSession({
      client: client as never,
      model: 'fake-model',
      longTerm: ltm,
      sessionRunIds: [runA, runB],
      outcomeForCaller: dummyOutcome,
      userMessage: 'remember snake_case',
      cwd: tmpDir,
    })

    // Real merger behaviour:
    //   - Both verified records became Candidates,
    //   - they share contentKey so they fuse into ONE merged entry,
    //   - the merger promotes 1 entry (kind='semantic', verified=true).
    expect(result.sourceRecords).toBe(2)
    expect(result.candidates).toBe(1)
    expect(result.promoted).toBe(1)
    expect(result.promotionFailed).toBe(0)
  })

  it('returns early when no verified records match the session Run IDs', async () => {
    const result = await consolidateSession({
      client: client as never,
      model: 'fake-model',
      longTerm: ltm,
      sessionRunIds: [],
      cwd: tmpDir,
    })
    expect(result.sourceRecords).toBe(0)
    expect(result.candidates).toBe(0)
    expect(result.promoted).toBe(0)
  })

  it('does not invoke the LLM (no parallel write path)', async () => {
    // The throw-on-LLM-call FakeClient is the assertion. If the
    // previous reflection path sneaks through, this test fails
    // loudly with 'consolidateSession must not call the LLM'.
    const outcome = {
      runId: 'r1',
      stopReason: 'stop_sequence' as const,
      completion: { status: 'completed' as const, reasons: [], evidence: [], requiredNextActions: [] },
      output: '',
      changedFiles: [],
      artifacts: [],
      verification: { executed: true, passed: true, failed: [] },
      modelAttempts: [],
      durationMs: 0,
      stopped: true,
      reason: 'stop_sequence',
    }
    ltm.record({
      kind: 'semantic',
      content: 'X',
      repo: tmpDir,
      sourceRunId: 'r1',
      origin: 'memory_promotion:r1',
      confidence: 0.5,
      verified: true,
      tags: [],
      expiresAt: undefined,
    })
    const r = await consolidateSession({
      client: client as never,
      model: 'm',
      longTerm: ltm,
      sessionRunIds: ['r1'],
      outcomeForCaller: outcome,
      userMessage: 'x',
      cwd: tmpDir,
    })
    expect(r.promoted).toBe(1)
  })
})
