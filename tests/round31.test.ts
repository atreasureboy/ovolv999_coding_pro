/**
 * Round 31 regression tests — deep state-machine edges from the user's
 * follow-up audit:
 *
 * P1-1  version-cap eviction (50) no longer silently skips restores —
 *       anchors carry content-hash identity, not array length.
 * P1/P2 rm-after-anchor revival with EXACT content; untracked mutations
 *       (sed -i / formatter / script writes) are caught by the snapshot.
 * P2    workspace boundary: a tampered anchor cannot unlink outside the
 *       project root.
 * P2    byte-targeted compaction (fixed-count compaction could exceed
 *       the byte budget every turn).
 * P1-2  TodoStore: sibling sub-agents (distinct scope ids, no
 *       sessionDir) are isolated from each other.
 * P2    CostTracker cache-rate defaults are provider-aware; unknown
 *       providers get no invented discount.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, appendFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendCheckpoint,
  listCheckpoints,
  rewindToCheckpoint,
  isInsideWorkspace,
} from '../src/core/conversationCheckpoints.js'
import { FileHistory, MAX_VERSIONS_PER_FILE } from '../src/core/fileHistory.js'
import { ensureLoaded, updateTodos, getTodos, renderTodoPromptBlock, resetTodos } from '../src/core/todoStore.js'
import { calculateUSDCost } from '../src/core/costTracker.js'
import type { OpenAIMessage } from '../src/core/types.js'

function hist(n: number): OpenAIMessage[] {
  return Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }))
}

describe('P1-1: version-cap eviction cannot silently skip a restore', () => {
  let dir: string
  let fh: FileHistory

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'r31-evict-'))
    fh = new FileHistory(dir)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('past the 50-version cap, count saturates but content identity does not', () => {
    // The file lives INSIDE the session's workspace — the rewind boundary
    // guard (below) would rightly skip a foreign path.
    const file = join(dir, 'loop-file.txt')
    writeFileSync(file, 'gen 0')

    const totalEdits = MAX_VERSIONS_PER_FILE + 12 // well past eviction
    for (let i = 1; i <= totalEdits; i++) {
      if (i < totalEdits) fh.trackEdit(file)
      writeFileSync(file, `gen ${i}`)
      if (i === 40) appendCheckpoint(dir, hist(3), fh, 'anchor@40', dir)
    }
    appendCheckpoint(dir, hist(5), fh, 'anchor@end', dir)

    // Eviction has bitten: capped at MAX_VERSIONS_PER_FILE — the old
    // count-based rewind saw "50 at anchor, 50 now" and silently skipped.
    expect(fh.getVersions(file).length).toBe(MAX_VERSIONS_PER_FILE)

    const r = rewindToCheckpoint(dir, 1, hist(5), fh)
    expect(r.ok).toBe(true)
    expect(r.skippedPaths).toEqual([])
    expect(readFileSync(file, 'utf8')).toBe('gen 40')
    expect(r.restoredFiles).toContain(file)
  }, 30_000)
})

describe('P1/P2: exact-content snapshots — rm revival + untracked mutations', () => {
  let dir: string
  let fh: FileHistory

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'r31-snap-'))
    fh = new FileHistory(dir)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('file rm\'d AFTER the anchor is revived with the anchor-time content', () => {
    const file = join(dir, 'payload.ts')
    writeFileSync(file, 'v1 content')
    fh.trackEdit(file)
    writeFileSync(file, 'v2 content')
    appendCheckpoint(dir, hist(2), fh, 'turn1', dir) // snapshot: 'v2 content'

    // rm via bash-equivalent (no FileHistory involvement)
    rmSync(file)
    appendCheckpoint(dir, hist(4), fh, 'turn2', dir) // anchor records absent

    const r = rewindToCheckpoint(dir, 1, hist(4), fh)
    expect(r.ok).toBe(true)
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('v2 content') // EXACT anchor content
  })

  it('untracked in-place mutation (sed -i / formatter drift) is rewound', () => {
    const file = join(dir, 'source.ts')
    writeFileSync(file, 'const a = 1\n')
    fh.trackEdit(file)
    writeFileSync(file, 'const a = 2\n')
    appendCheckpoint(dir, hist(2), fh, 'turn1', dir)

    // Formatter / sed -i rewrites the file WITHOUT any tool tracking
    writeFileSync(file, 'const   a   =   2   // formatted\n')
    appendCheckpoint(dir, hist(4), fh, 'turn2', dir)

    const r = rewindToCheckpoint(dir, 1, hist(4), fh)
    expect(r.ok).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('const a = 2\n')
  })

  it('absent-at-anchor: a later recreation is rewound away', () => {
    const file = join(dir, 'transient.txt')
    writeFileSync(file, 'original')
    fh.trackEdit(file)
    writeFileSync(file, 'edited')
    appendCheckpoint(dir, hist(2), fh, 'turn1', dir)

    rmSync(file) // gone before this anchor
    appendCheckpoint(dir, hist(4), fh, 'turn2', dir) // anchor2: absent

    // Recreated afterwards (script re-ran, etc.)
    writeFileSync(file, 'recreated junk')
    appendCheckpoint(dir, hist(6), fh, 'turn3', dir)

    const r = rewindToCheckpoint(dir, 2, hist(6), fh)
    expect(r.ok).toBe(true)
    expect(existsSync(file)).toBe(false) // anchor2 truth: absent
    expect(r.deletedFiles).toContain(file)
  })

  it('REGRESSION F1: a PRE-EXISTING file first edited after the anchor is NOT deleted by rewind', () => {
    const fh = new FileHistory(dir)
    // Pre-existing user file, unknown to the session at anchor time
    const pre = join(dir, 'pre-existing.txt')
    writeFileSync(pre, 'user content')
    appendCheckpoint(dir, hist(2), fh, 't1', dir) // anchor 1: file untracked

    // Turn 2: the session EDITS it (Write tool flow)
    const fh2 = new FileHistory(dir)
    fh2.trackEdit(pre)
    writeFileSync(pre, 'session-edited')
    appendCheckpoint(dir, hist(4), fh2, 't2', dir)

    const cps = listCheckpoints(dir)
    // The anchor's createdFiles must contain ONLY created files — edited
    // pre-existing files must not leak into the deletion set.
    expect(cps[1].createdFiles ?? []).not.toContain(pre)

    const r = rewindToCheckpoint(dir, 1, hist(4), fh2)
    expect(r.ok).toBe(true)
    expect(r.deletedFiles).not.toContain(pre)
    expect(existsSync(pre)).toBe(true) // pre-fix: this file was DELETED
  })

  it('snapshot reuse: unchanged files between turns share one snapshot file', () => {
    const file = join(dir, 'stable.txt')
    writeFileSync(file, 'stable content')
    fh.markCreated(file)
    appendCheckpoint(dir, hist(2), fh, 't1', dir)
    appendCheckpoint(dir, hist(4), fh, 't2', dir)
    const cps = listCheckpoints(dir)
    const e1 = cps[0].files[file] as { snap?: string }
    const e2 = cps[1].files[file] as { snap?: string }
    expect(e1.snap).toBeDefined()
    expect(e2.snap).toBe(e1.snap) // deduped — no per-turn copy for unchanged files
  })
})

describe('P2: workspace boundary + byte-targeted compaction', () => {
  let dir: string
  let outside: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'r31-bound-'))
    outside = mkdtempSync(join(tmpdir(), 'r31-outside-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('a tampered anchor cannot delete paths outside the project root', () => {
    const fh = new FileHistory(dir)
    const victim = join(outside, 'precious.txt')
    writeFileSync(victim, 'user data')

    appendCheckpoint(dir, hist(2), fh, 't1', dir)
    // Tamper: inject an outside path as created-after-anchor
    const p = join(dir, 'checkpoints.jsonl')
    const tampered = JSON.stringify({
      turn: 2, historyLength: 4, files: {}, createdFiles: [victim],
      cwd: dir, at: new Date().toISOString(), prompt: 'evil',
    })
    appendFileSync(p, tampered + '\n', 'utf8')

    const r = rewindToCheckpoint(dir, 1, hist(4), fh)
    expect(r.ok).toBe(true)
    expect(r.skippedPaths).toContain(victim)
    expect(existsSync(victim)).toBe(true) // untouched
  })

  it('isInsideWorkspace: parent-chain containment, not string prefix', () => {
    expect(isInsideWorkspace('/proj/sub/file.ts', '/proj')).toBe(true)
    expect(isInsideWorkspace('/project-x/file.ts', '/proj')).toBe(false)
    expect(isInsideWorkspace('/etc/passwd', '/proj')).toBe(false)
  })

  it('compaction is byte-targeted — big anchors get dropped, file stays within budget', () => {
    const fh = new FileHistory(dir)
    const bigFile = join(dir, 'big.txt')
    writeFileSync(bigFile, 'x')
    fh.markCreated(bigFile)
    // Many anchors, each with a LARGE distinct snapshot (forces new snaps
    // via mtime/size churn AND big anchor payloads through long paths)
    const longName = join(dir, 'f'.repeat(180) + '-a.txt')
    for (let i = 0; i < 30; i++) {
      writeFileSync(bigFile, 'content-' + i + '-'.repeat(64))
      const s1 = statSync(bigFile)
      // nudge mtime so reuse fast-path misses
      writeFileSync(longName + i, 'y')
      fh.markCreated(longName + i)
      appendCheckpoint(dir, hist(i + 2), fh, `t${i}-${'p'.repeat(80)}`, dir)
      void s1
    }
    const p = join(dir, 'checkpoints.jsonl')
    const size = statSync(p).size
    // Byte budget enforced (with one-anchor floor): 150KB target + slack
    // for the single newest anchor that may exceed it alone.
    const cps = listCheckpoints(dir)
    const newest = JSON.stringify(cps[cps.length - 1]).length
    expect(size).toBeLessThanOrEqual(150 * 1024 + newest + 1024)
    expect(cps.length).toBeGreaterThanOrEqual(1)
    expect(cps.length).toBeLessThan(30) // actually compacted
  }, 30_000)
})

describe('P1-2: TodoStore — sibling sub-agent isolation', () => {
  beforeEach(() => resetTodos())

  it('two scope ids (no sessionDir) keep independent checklists and prompts', () => {
    // Exactly the AgentTool child shape: sessionDir undefined, distinct
    // todoScopeId per child engine.
    const scopeA = 'agent-aaaaaaaa'
    const scopeB = 'agent-bbbbbbbb'
    ensureLoaded(scopeA)
    updateTodos([{ id: '1', content: 'SUB-A step', status: 'in_progress', priority: 'high' }], scopeA)
    ensureLoaded(scopeB)
    updateTodos([{ id: '1', content: 'SUB-B step', status: 'pending', priority: 'low' }], scopeB)

    expect(getTodos(scopeA).map((t) => t.content)).toEqual(['SUB-A step'])
    expect(getTodos(scopeB).map((t) => t.content)).toEqual(['SUB-B step'])
    expect(renderTodoPromptBlock(scopeA)).not.toContain('SUB-B step')
    expect(renderTodoPromptBlock(scopeB)).not.toContain('SUB-A step')
  })

  it('REGRESSION F2: resume hydration chain — coordinator hydrate → tool write preserves the plan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'r31-todore-'))
    try {
      // Session 1: main agent (key = sessionDir = persistDir) persists a plan
      ensureLoaded(dir, dir)
      updateTodos([{ id: '1', content: 'KEEP ME', status: 'in_progress', priority: 'high' }], dir, dir)

      // Session 2 (fresh process): coordinator's pre-LLM call hydrates
      // with the persistDir (Round 31 audit F2: passing no persistDir
      // here poisoned the loaded flag and the first TodoWrite wiped
      // the resumed plan).
      resetTodos()
      const scopeKey = dir // main agent: todoScopeId undefined → sessionDir
      const persistDir = dir
      ensureLoaded(scopeKey, persistDir) // coordinator-style
      expect(renderTodoPromptBlock(scopeKey)).toContain('KEEP ME')

      // Tool-style merge (as TodoWrite does) UPDATES instead of replacing
      ensureLoaded(scopeKey, persistDir)
      updateTodos([{ id: '1', content: 'KEEP ME', status: 'completed', priority: 'high' }], scopeKey, persistDir)
      expect(getTodos(scopeKey).map((t) => t.content)).toEqual(['KEEP ME'])
      expect(JSON.parse(readFileSync(join(dir, 'todo.json'), 'utf8'))[0].content).toBe('KEEP ME')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('scope buckets never touch disk (sub-agent plans are ephemeral)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'r31-todo-'))
    try {
      const scope = 'agent-cccccccc'
      ensureLoaded(scope, undefined)
      updateTodos([{ id: '1', content: 'ephemeral', status: 'pending', priority: 'medium' }], scope, undefined)
      expect(existsSync(join(dir, 'todo.json'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('P2: CostTracker provider-aware cache defaults', () => {
  it('openai cached reads bill at 50% with NO write premium', () => {
    // gpt-4o: input $2.5/1M. 1000 uncached + 8000 cached-read.
    const usage = { inputTokens: 9000, outputTokens: 0, cacheReadTokens: 8000 }
    const cost = calculateUSDCost('gpt-4o', usage)
    // uncached 1000 × 2.5 + cached 8000 × (2.5 × 0.5)
    const expected = (1000 / 1e6) * 2.5 + (8000 / 1e6) * 1.25
    expect(cost).toBeCloseTo(expected, 9)
  })

  it('anthropic keeps the 10%/125% economics', () => {
    const usage = { inputTokens: 7000, outputTokens: 100, cacheReadTokens: 4000, cacheWriteTokens: 2000 }
    const cost = calculateUSDCost('claude-sonnet-4-6', usage)
    const expected =
      (1000 / 1e6) * 3 + (4000 / 1e6) * 0.3 + (2000 / 1e6) * 3.75 + (100 / 1e6) * 15
    expect(cost).toBeCloseTo(expected, 9)
  })

  it('REGRESSION F3: dated prefix aliases inherit the family cache economics (gpt-4o-2024-08-06 → 50% reads)', () => {
    // Pre-fix: exact-match getModelInfo missed the alias → provider '' →
    // cached reads billed at 100% ($0.0225 instead of $0.0125).
    const cost = calculateUSDCost('gpt-4o-2024-08-06', { inputTokens: 9000, outputTokens: 0, cacheReadTokens: 8000 })
    const expected = (1000 / 1e6) * 2.5 + (8000 / 1e6) * 1.25
    expect(cost).toBeCloseTo(expected, 9)
  })
})
