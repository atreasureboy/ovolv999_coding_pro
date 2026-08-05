/**
 * v0.5.3 Hotfix §6 — Memory Promotion events.
 *
 * MemoryModule.onComplete must emit MEMORY_PROMOTION_STARTED,
 * MEMORY_PROMOTION_DECIDED, and MEMORY_PROMOTION_REJECTED via
 * EventLog so post-run audit can prove claims actually wired.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { EventLog } from '../../src/core/eventLog.js'
import { MemoryModule } from '../../src/modules/memory.js'
import { SemanticMemory } from '../../src/core/semanticMemory.js'
import { EpisodicMemory } from '../../src/core/episodicMemory.js'
import { resolveProjectIdentity } from '../../src/core/projectIdentity.js'
import type { ModuleRunContext } from '../../src/core/module.js'
import type { MemoryCandidate } from '../../src/core/memoryCandidate.js'
import type { TurnOutcome } from '../../src/core/runtime/turnOutcome.js'

function successOutcome(runId: string): TurnOutcome {
  return {
    runId,
    stopReason: 'stop_sequence',
    completion: { status: 'completed', reasons: [], evidence: [], requiredNextActions: [] },
    output: '',
    changedFiles: [],
    artifacts: [],
    verification: { executed: true, passed: true, failed: [] },
    modelAttempts: [],
    stopped: true,
    reason: 'stop_sequence',
  }
}

function makeCandidate(id: string, runId: string): MemoryCandidate {
  return {
    id,
    runId,
    content: `content for ${id}`,
    claimedSource: 'user_stated',
    tags: [],
    confidence: 0.9,
    createdAt: '2026-01-01',
  }
}

describe('Memory Promotion events (Hotfix §6)', () => {
  let ovogoHome: string
  let projectDir: string
  let eventLog: EventLog

  beforeEach(async () => {
    ovogoHome = mkdtempSync(join(tmpdir(), 'ovolv999-memevents-'))
    process.env.OVOGO_HOME = ovogoHome
    projectDir = mkdtempSync(join(tmpdir(), 'ovolv999-memevents-proj-'))
    const id = await resolveProjectIdentity({ cwd: projectDir })
    void id
    eventLog = new EventLog(join(projectDir, 'events.jsonl'))
  })
  afterEach(() => {
    try { rmSync(ovogoHome, { recursive: true, force: true }) } catch { /* best-effort */ }
    try { rmSync(projectDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    delete process.env.OVOGO_HOME
  })

  it('emits MEMORY_PROMOTION_STARTED + DECIDED + REJECTED for each candidate', async () => {
    const id = await resolveProjectIdentity({ cwd: projectDir })
    const sem = new SemanticMemory(join(projectDir, '.ovogo'))
    const epi = new EpisodicMemory(projectDir)
    const mod = new MemoryModule(sem, epi)
    mod.boot({ cwd: projectDir, config: { cwd: projectDir } as never, projectIdentity: id })

    const runId = 'r-1'
    const ctx: ModuleRunContext = {
      cwd: projectDir,
      sessionDir: join(projectDir, '.session'),
      outcome: successOutcome(runId),
      turnResult: {} as never,
      messages: [],
      eventLog,
      runContext: {
        userMessage: 'use snake_case naming please',
        memoryCandidates: [
          // Forge one (will be rejected) + one verified.
          makeCandidate('forge', runId), // no sourceQuote → drop
          {
            id: 'verified',
            runId,
            content: 'use snake_case naming',
            claimedSource: 'user_stated',
            sourceQuote: 'use snake_case naming',
            tags: [],
            confidence: 0.9,
            createdAt: '2026-01-01',
          },
          {
            id: 'also-verified',
            runId,
            content: 'note about coffee brewing',
            claimedSource: 'agent_inferred',
            tags: [],
            confidence: 0.7,
            createdAt: '2026-01-01',
            evidenceRefs: [{ kind: 'file', path: '/some/file' }],
          },
        ],
      } as never,
    }
    await mod.onComplete(ctx)

    const events = eventLog.readAll()
    const started = events.filter((e) => e.type === 'memory_promotion_started')
    const decided = events.filter((e) => e.type === 'memory_promotion_decided')
    const rejected = events.filter((e) => e.type === 'memory_promotion_rejected')

    expect(started.length).toBe(1)
    expect(started[0].detail.candidateCount).toBe(3)
    expect(decided.length).toBeGreaterThanOrEqual(1)
    expect(rejected.length).toBeGreaterThanOrEqual(1)
    // The forged candidate's id appears in the rejected event
    expect(rejected.some((e) => e.detail.candidateId === 'forge')).toBe(true)
    // The verified candidate's id appears in the decided event
    expect(decided.some((e) => e.detail.candidateId === 'verified')).toBe(true)
  })
})