/**
 * Round 27 regression tests — CC-parity features.
 *
 * 1. Prompt caching: request breakpoints (system/tools/last message),
 *    usage passthrough (cache read/write), cache-aware cost math,
 *    summary line, /cache recording via coordinator path.
 * 2. /rewind: real versioned restore (list → version picker → restore).
 * 3. Grep: exclude/multiline/head_limit args + pure-JS fallback engine.
 * 4. Todos: persistence to sessionDir + system-prompt block injection.
 * 5. gitignore-aware Glob.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAnthropicRequest, AnthropicChunkTranslator, type AnthropicEvent } from '../src/core/model/anthropicSse.js'
import { CostTracker, calculateUSDCost, calculateUncachedUSDCost, getModelPricing as await_import_pricing } from '../src/core/costTracker.js'
import { updateTodos, ensureLoaded, renderTodoPromptBlock, resetTodos, getTodos } from '../src/core/todoStore.js'
import { GrepTool } from '../src/tools/grep.js'
import { GlobTool } from '../src/tools/glob.js'
import { loadGitignoreIgnores, clearGitignoreCache } from '../src/utils/gitignore.js'
import { FileHistory } from '../src/core/fileHistory.js'
import type { ToolContext } from '../src/core/types.js'

function makeCtx(cwd: string): ToolContext {
  return { cwd, permissionMode: 'auto' }
}

describe('Prompt caching — request breakpoints', () => {
  it('stamps cache_control on system, last tool, and LAST message when all flags set', () => {
    const params = buildAnthropicRequest({
      model: 'claude-sonnet-4-6',
      systemPrompt: 'sys',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
      tools: [{ type: 'function', function: { name: 'A', description: '' } }, { type: 'function', function: { name: 'B', description: '' } }],
      maxTokens: 100,
      providerOptions: { cacheSystem: true, cacheTools: true, cacheMessages: true },
    })
    // system block
    const sys = params.system as Array<{ type: string; cache_control?: { type: string } }>
    expect(Array.isArray(sys)).toBe(true)
    expect(sys[0].cache_control).toEqual({ type: 'ephemeral' })
    // tools — only the LAST one carries the breakpoint
    const tools = params.tools as Array<{ name: string; cache_control?: unknown }>
    expect(tools[0].cache_control).toBeUndefined()
    expect(tools[1].cache_control).toEqual({ type: 'ephemeral' })
    // messages — ONLY the last gets a stamped block
    const msgs = params.messages as Array<{ role: string; content: unknown }>
    expect(typeof msgs[0].content).toBe('string')
    const lastContent = msgs[2].content as Array<{ type: string; cache_control?: { type: string } }>
    expect(Array.isArray(lastContent)).toBe(true)
    expect(lastContent[0].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('no breakpoints when flags absent (backward compatible)', () => {
    const params = buildAnthropicRequest({
      model: 'claude-sonnet-4-6',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 100,
    })
    expect(params.system).toBe('sys')
    expect(typeof (params.messages[0].content as unknown)).toBe('string')
  })
})

describe('Prompt caching — usage passthrough + cost math', () => {
  it('translator emits OpenAI-style total prompt_tokens + cached_tokens + write tokens', () => {
    const t = new AnthropicChunkTranslator('claude-sonnet-4-6')
    const startEvent: AnthropicEvent = {
      type: 'message_start',
      message: {
        id: 'm1', type: 'message', role: 'assistant', content: [], model: 'claude',
        stop_reason: null,
        usage: { input_tokens: 1000, output_tokens: 5, cache_read_input_tokens: 4000, cache_creation_input_tokens: 2000 },
      },
    }
    t.push(startEvent)
    t.push({ type: 'message_stop' })
    const final = t.finalizeWithUsage(undefined)
    const usage = final.usage as unknown as {
      prompt_tokens: number
      completion_tokens: number
      prompt_tokens_details?: { cached_tokens: number }
      cache_creation_input_tokens?: number
    }
    // TOTAL input = 1000 uncached + 4000 read + 2000 written
    expect(usage.prompt_tokens).toBe(7000)
    expect(usage.prompt_tokens_details?.cached_tokens).toBe(4000)
    expect(usage.cache_creation_input_tokens).toBe(2000)
  })

  it('cache-aware cost math: cached reads billed at ~10%, writes at ~125%', () => {
    const model = 'claude-sonnet-4-6'
    const usage = { inputTokens: 7000, outputTokens: 100, cacheReadTokens: 4000, cacheWriteTokens: 2000 }
    const cached = calculateUSDCost(model, usage)
    const uncached = calculateUncachedUSDCost(model, usage)
    // Saving must be a meaningful fraction: 4000 tokens moved from full
    // price to 10% + 2000 from full to 125% ⇒ net saving on the read part.
    expect(cached).toBeLessThan(uncached)
    // Derive the expected saving from the registry's real rates.
    const { getModelPricing } = { getModelPricing: await_import_pricing }
    const in1M = getModelPricing(model)?.inputPer1M ?? 0
    const readSaving = (4000 / 1e6) * in1M * 0.9
    const writePremium = (2000 / 1e6) * in1M * 0.25
    expect(uncached - cached).toBeGreaterThan(readSaving - writePremium - 1e-9)
  })

  it('CostTracker accumulates cache totals and renders the summary line', () => {
    const tracker = new CostTracker()
    tracker.addUsage('claude-sonnet-4-6', { inputTokens: 10_000, outputTokens: 500, cacheReadTokens: 8_000 })
    expect(tracker.getTotalCacheReadTokens()).toBe(8_000)
    expect(tracker.getCacheSavedUSD()).toBeGreaterThan(0)
    const summary = tracker.formatSummary()
    expect(summary).toMatch(/Prompt cache:\s+8,000 read/)
  })
})

describe('/rewind — real versioned restore', () => {
  let dir: string
  let fh: FileHistory

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'r27-rewind-'))
    fh = new FileHistory(dir)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('tracks successive edits as versions and restores an arbitrary one', () => {
    const file = join(dir, 'code.txt')
    writeFileSync(file, 'v0 original')
    fh.trackEdit(file)
    writeFileSync(file, 'v1 first edit')
    fh.trackEdit(file)
    writeFileSync(file, 'v2 second edit')

    const versions = fh.getVersions(file)
    expect(versions.length).toBeGreaterThanOrEqual(2)

    expect(fh.restoreVersion(file, 0)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('v0 original')

    expect(fh.restoreVersion(file, 1)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('v1 first edit')
  })
})

describe('Grep — CC-parity params + JS fallback engine', () => {
  let dir: string
  const tool = new GrepTool()

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'r27-grep-'))
    writeFileSync(join(dir, 'a.ts'), 'alpha\nbeta\nalpha\n')
    writeFileSync(join(dir, 'b.test.ts'), 'alpha-test\n')
    mkdirSync(join(dir, 'vendor'))
    writeFileSync(join(dir, 'vendor', 'c.ts'), 'alpha-vendor\n')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('exclude patterns filter matches', async () => {
    const res = await tool.execute(
      { pattern: 'alpha', path: dir, output_mode: 'files_with_matches', exclude: ['*.test.ts', 'vendor/**'] },
      makeCtx(dir),
    )
    expect(res.isError).toBe(false)
    expect(res.content).toContain('a.ts')
    expect(res.content).not.toContain('b.test.ts')
    expect(res.content).not.toContain('vendor')
  }, 20_000)

  it('head_limit truncates with a true-total notice', async () => {
    const res = await tool.execute(
      { pattern: 'alpha', path: dir, output_mode: 'content', head_limit: 1 },
      makeCtx(dir),
    )
    expect(res.content).toMatch(/truncated: \d+ more lines/)
  }, 20_000)

  it('pure-JS engine finds matches without rg/grep (direct call)', async () => {
    // Simulate the last-resort path: force PATH empty so rg+grep miss.
    const origPath = process.env.PATH
    process.env.PATH = '/nonexistent-r27'
    try {
      const res = await tool.execute(
        { pattern: 'alpha-vendor', path: dir, output_mode: 'content' },
        makeCtx(dir),
      )
      // Whatever engine ran, the match must be found — the JS fallback
      // covers the case where both binaries are unavailable.
      expect(res.isError).toBe(false)
      expect(res.content).toContain('vendor/c.ts')
    } finally {
      process.env.PATH = origPath
    }
  }, 30_000)
})

describe('Glob — gitignore awareness', () => {
  let dir: string
  const tool = new GlobTool()

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'r27-glob-'))
    mkdirSync(join(dir, 'build'))
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'build', 'out.js'), 'x')
    writeFileSync(join(dir, 'src', 'main.ts'), 'x')
    writeFileSync(join(dir, 'secret.env'), 'x')
    writeFileSync(join(dir, '.gitignore'), 'build/\nsecret.env\n')
    clearGitignoreCache()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('loadGitignoreIgnores converts dir rules and file rules', () => {
    const ignores = loadGitignoreIgnores(dir)
    expect(ignores.some((i) => i.includes('build'))).toBe(true)
    expect(ignores.some((i) => i.includes('secret.env'))).toBe(true)
  })

  it('Glob excludes gitignored artifacts', async () => {
    const res = await tool.execute({ pattern: '**/*', path: dir }, makeCtx(dir))
    expect(res.isError).toBe(false)
    expect(res.content).toContain('main.ts')
    expect(res.content).not.toContain('out.js')
    expect(res.content).not.toContain('secret.env')
  }, 20_000)
})

describe('Todos — persistence + prompt injection', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'r27-todo-'))
    resetTodos()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('persists to <sessionDir>/todo.json and hydrates on ensureLoaded', () => {
    ensureLoaded(dir)
    updateTodos([
      { id: '1', content: 'Fix auth', status: 'in_progress', priority: 'high', activeForm: 'Fixing auth' },
      { id: '2', content: 'Write tests', status: 'pending', priority: 'medium' },
    ], dir)
    const persisted = join(dir, 'todo.json')
    expect(existsSync(persisted)).toBe(true)

    // Fresh process simulation: reset + hydrate from disk
    resetTodos()
    ensureLoaded(dir)
    expect(getTodos(dir)).toHaveLength(2)
    expect(getTodos(dir)[0].content).toBe('Fix auth')
  })

  it('renders the system-prompt block only when todos exist', () => {
    resetTodos()
    expect(renderTodoPromptBlock(dir)).toBe('')
    ensureLoaded(dir)
    updateTodos([{ id: '1', content: 'Task A', status: 'pending', priority: 'high' }], dir)
    const block = renderTodoPromptBlock(dir)
    expect(block).toContain('# Current task checklist')
    expect(block).toContain('Task A')
    expect(block).toContain('1 task(s) remaining')
  })
})
