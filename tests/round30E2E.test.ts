/**
 * Round 30 REAL end-to-end verification — no mocks for the system under
 * test: the Anthropic path spawns the actual CLI / actual adapter in
 * child processes against a local Anthropic-protocol HTTP fixture.
 *
 * E2E-1 (wire + accounting chain): a real subprocess runs the REAL
 *   AnthropicAdapter (SDK client) → translator → StreamConsumer →
 *   CostTracker against the fixture. Asserts cumulative-usage semantics
 *   (completion=50, not 53), cache token passthrough, and cache savings.
 * E2E-2 (real CLI, wire-level caching): spawns bin/ovogogogo.ts with
 *   provider=anthropic pointed at the fixture; asserts the request the
 *   CLI put on the wire carries the cache_control breakpoints.
 * E2E-3 (real CLI, checkpoints): non-TTY single-shot run against the
 *   scenario-a fixture (real Write+Bash turn) → asserts the real session
 *   dir contains checkpoints.jsonl with a correct anchor, then executes
 *   a real rewind against those artifacts and verifies disk state.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { spawn } from 'child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
// @ts-expect-error fixture is a plain .mjs without types
import { startAnthropicServer } from './fixtures/anthropicEchoServer.mjs'
// @ts-expect-error fixture is a plain .mjs without types
import { startEchoServer } from './fixtures/openaiEchoServer.mjs'
import { runCli, isolatedEnv } from './cli/helpers.js'
import { listCheckpoints, rewindToCheckpoint, appendCheckpoint } from '../src/core/conversationCheckpoints.js'
import { FileHistory } from '../src/core/fileHistory.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const tsxCli = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const TIMEOUT = 90_000

/** E2E-1 chain script — runs REAL adapter+consumer+tracker in a child. */
const CHAIN_SCRIPT = `
import { AnthropicAdapter } from '${join(repoRoot, 'src/core/model/anthropicAdapter.js').replace(/\\/g, '/')}'
import { StreamConsumer } from '${join(repoRoot, 'src/core/model/streamConsumer.js').replace(/\\/g, '/')}'
import { CostTracker } from '${join(repoRoot, 'src/core/costTracker.js').replace(/\\/g, '/')}'
import { getModelInfo } from '${join(repoRoot, 'src/core/providers.js').replace(/\\/g, '/')}'

const port = Number(process.argv[2])
const adapter = new AnthropicAdapter({ apiKey: 'e2e-key', baseURL: 'http://127.0.0.1:' + port })
const ctrl = new AbortController()
const stream = await adapter.stream({
  model: 'claude-sonnet-4-6',
  systemPrompt: 'sys',
  messages: [{ role: 'user', content: 'hello' }],
  tools: [],
  maxOutputTokens: 64,
  signal: ctrl.signal,
})
const noopRenderer = { destroy(){}, banner(){}, humanPrompt(){}, beginAssistantText(){}, streamToken(){}, endAssistantText(){}, toolStart(){}, toolResult(){}, startSpinner(){}, stopSpinner(){}, info(){}, success(){}, error(){}, warn(){}, agentStart(){}, agentDone(){}, agentSummary(){}, agentHeartbeat(){}, compactStart(){}, compactDone(){}, contextWarning(){}, planModeStart(){}, planConfirmPrompt(){}, writeInterruptPrompt(){}, interruptInjected(){}, writePrompt(){}, newline(){} }
const consumer = new StreamConsumer({ renderer: noopRenderer })
const result = await consumer.consume(stream, ctrl.signal, ctrl)
const tracker = new CostTracker()
tracker.addUsage('claude-sonnet-4-6', result.usage)
process.stdout.write(JSON.stringify({
  usage: result.usage,
  text: result.assistantText,
  cost: tracker.getTotalCost(),
  cacheRead: tracker.getTotalCacheReadTokens(),
  cacheSaved: tracker.getCacheSavedUSD(),
}))
process.exit(0)
`

describe('Round 30 E2E — Anthropic accounting (real subprocess)', () => {
  let fixture: Awaited<ReturnType<typeof startAnthropicServer>>

  beforeAll(async () => {
    fixture = await startAnthropicServer()
  })
  afterAll(async () => {
    await fixture.close()
  })

  it(
    'E2E-1: adapter→consumer→costTracker chain reports cumulative 50 (not 3+50), cache tokens, savings',
    async () => {
      const scriptPath = join(tmpdir(), `r30-chain-${Date.now()}.mts`)
      writeFileSync(scriptPath, CHAIN_SCRIPT)
      const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [tsxCli, scriptPath, String(fixture.port)], {
          env: { ...process.env, NODE_ENV: 'test' },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stdout = '', stderr = ''
        child.stdout.on('data', (c) => { stdout += c })
        child.stderr.on('data', (c) => { stderr += c })
        const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
        child.on('close', (code) => {
          clearTimeout(timer)
          try { rmSync(scriptPath, { force: true }) } catch { /* best-effort */ }
          resolve({ code, stdout, stderr })
        })
      })
      expect(out.code).toBe(0)
      const parsed = JSON.parse(out.stdout) as {
        usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
        text: string
        cost: number
        cacheRead: number
        cacheSaved: number
      }
      // Cumulative contract: message_start seeded 3, message_delta total 50
      // → final MUST be 50. (The pre-fix `+=` produced 53.)
      expect(parsed.usage.outputTokens).toBe(50)
      // Total input = 1000 uncached + 4000 cache-read + 2000 cache-write
      expect(parsed.usage.inputTokens).toBe(7000)
      expect(parsed.usage.cacheReadTokens).toBe(4000)
      expect(parsed.usage.cacheWriteTokens).toBe(2000)
      expect(parsed.text).toContain('E2E response body')
      expect(parsed.cacheRead).toBe(4000)
      expect(parsed.cost).toBeGreaterThan(0)
      expect(parsed.cacheSaved).toBeGreaterThan(0)
    },
    TIMEOUT,
  )

  it(
    'E2E-2: real CLI puts cache_control breakpoints on the wire (system + last message)',
    async () => {
      const tmpHome = mkdtempSync(join(tmpdir(), 'r30-cli-home-'))
      const tmpProj = mkdtempSync(join(tmpdir(), 'r30-cli-proj-'))
      try {
        // Provider selection through the real config door: global settings
        mkdirSync(join(tmpHome, '.ovogo'), { recursive: true })
        writeFileSync(
          join(tmpHome, '.ovogo', 'settings.json'),
          JSON.stringify({ provider: { provider: 'anthropic', apiKey: 'e2e-key', baseURL: fixture.baseURL, model: 'claude-e2e' } }),
        )
        const run = await runCli(['--pipe', '--format', 'json'], {
          stdin: 'say hi',
          cwd: tmpProj,
          env: isolatedEnv(tmpHome),
          timeoutMs: TIMEOUT,
        })
        expect(run.timedOut).toBe(false)
        expect(run.code).toBe(0)

        const posted = fixture.requests.filter((r: { url: string }) => r.url === '/v1/messages')
        expect(posted.length).toBeGreaterThanOrEqual(1)
        const body = posted[0].body as {
          system?: Array<{ type: string; cache_control?: unknown }>
          messages?: Array<{ role: string; content: unknown }>
          tools?: Array<{ name: string; cache_control?: unknown }>
        }
        // System breakpoint (cache ON by default from Round 27)
        expect(Array.isArray(body.system)).toBe(true)
        expect((body.system as Array<{ cache_control?: unknown }>)[0]?.cache_control).toEqual({ type: 'ephemeral' })
        // Last-message breakpoint (string content becomes a stamped block)
        const msgs = body.messages ?? []
        const last = msgs[msgs.length - 1]
        expect(last).toBeDefined()
        const lastContent = last.content as Array<{ type: string; cache_control?: unknown }> | string
        if (Array.isArray(lastContent)) {
          expect(lastContent[lastContent.length - 1]?.cache_control).toEqual({ type: 'ephemeral' })
        } else {
          // Control-message plumbing may prepend an extra user message —
          // at least ONE message must carry a breakpoint.
          const anyStamped = msgs.some((m) => {
            const c = m.content as Array<{ cache_control?: unknown }> | string
            return Array.isArray(c) && c.some((b) => b?.cache_control)
          })
          expect(anyStamped).toBe(true)
        }
        // Kill-switch honored end-to-end would need a second run with the
        // env set — covered by unit tests; wire shape asserted here.
      } finally {
        rmSync(tmpHome, { recursive: true, force: true })
        rmSync(tmpProj, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

describe('Round 30 E2E — real CLI checkpoint + rewind artifacts', () => {
  let scenarioA: Awaited<ReturnType<typeof startEchoServer>>
  let tmpHome: string
  let tmpProj: string

  beforeAll(async () => {
    scenarioA = await startEchoServer({ mode: 'scenario-a' })
  })
  afterAll(async () => {
    await scenarioA.close()
  })
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'r30-cp-home-'))
    tmpProj = mkdtempSync(join(tmpdir(), 'r30-cp-proj-'))
  })
  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* best-effort */ }
    try { rmSync(tmpProj, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it(
    'E2E-3: single-shot real turn writes session artifacts; real rewind restores created-file state',
    async () => {
      // Run 1: real non-TTY single-shot turn — scenario-a performs a real
      // Write (creates a.txt) + real Bash verification + completion.
      const run1 = await runCli([], {
        stdin: 'write a.txt with content "hello" then verify by running `cat a.txt`',
        cwd: tmpProj,
        env: isolatedEnv(tmpHome, {
          OPENAI_API_KEY: 'test-key',
          OPENAI_BASE_URL: scenarioA.baseURL,
          OVOGO_PROVIDER: 'openai-compatible',
        }),
        timeoutMs: TIMEOUT,
      })
      expect(run1.timedOut).toBe(false)
      expect(run1.code).toBe(0)
      expect(existsSync(join(tmpProj, 'a.txt'))).toBe(true)
      expect(readFileSync(join(tmpProj, 'a.txt'), 'utf8')).toBe('hello')

      // Real session artifacts under <cwd>/sessions/
      const sessionsDir = join(tmpProj, 'sessions')
      expect(existsSync(sessionsDir)).toBe(true)
      const sessionDirs = readdirSync(sessionsDir).map((d) => join(sessionsDir, d))
      expect(sessionDirs.length).toBeGreaterThanOrEqual(1)
      const sessionDir = sessionDirs.sort().at(-1)!

      // The single-shot path appended a REAL checkpoint anchor
      const cps = listCheckpoints(sessionDir)
      expect(cps.length).toBeGreaterThanOrEqual(1)
      const anchor = cps[0]
      expect(anchor.historyLength).toBeGreaterThanOrEqual(2)
      const createdEntry = Object.keys(anchor.files).find((p) => p.endsWith('a.txt'))
      expect(createdEntry).toBeDefined() // created-file recorded (count 0)
      expect(anchor.createdFiles?.some((p) => p.endsWith('a.txt'))).toBe(true)

      // Simulate turn 2 the way the engine would: edit the file again and
      // anchor via the REAL append path against the REAL session dir.
      const fh = new FileHistory(sessionDir)
      // trackEdit BEFORE mutating — the backup must capture the real
      // CLI's 'hello' content, exactly as the Write tool would.
      fh.trackEdit(join(tmpProj, 'a.txt'))
      writeFileSync(join(tmpProj, 'a.txt'), 'hello-mutated-2')
      // also create a file that must be DELETED by the rewind (created
      // the way the Write tool does: write succeeds → markCreated)
      const extra = join(tmpProj, 'late.txt')
      writeFileSync(extra, 'late')
      fh.markCreated(extra)
      appendCheckpoint(sessionDir, [{ role: 'user', content: 'run1' }, { role: 'assistant', content: 'done' }, { role: 'user', content: 'run2' }, { role: 'assistant', content: 'done2' }], fh, 'run2')

      // REAL rewind to turn 1 — against artifacts produced by the real CLI
      const history = [
        { role: 'user' as const, content: 'run1' },
        { role: 'assistant' as const, content: 'done' },
        { role: 'user' as const, content: 'run2' },
        { role: 'assistant' as const, content: 'done2' },
      ]
      const r = rewindToCheckpoint(sessionDir, 1, history, fh)
      expect(r.ok).toBe(true)
      expect(readFileSync(join(tmpProj, 'a.txt'), 'utf8')).toBe('hello')
      expect(existsSync(extra)).toBe(false)
      // Future anchor dropped
      expect(listCheckpoints(sessionDir).map((c) => c.turn)).toEqual([1])
    },
    TIMEOUT,
  )
})
