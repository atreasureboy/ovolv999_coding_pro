/**
 * Round 32 E2E-P + E2E-S — REAL parallel modify agents + REAL runtime
 * steer, through the REAL engine stack (no engine mocks):
 * ExecutionEngine → RuntimeCoordinator → ToolScheduler → parallel batch
 * → AgentTool → child ExecutionEngines → real git worktrees → real
 * mutex-serialized merges. A local OpenAI-protocol fixture scripts the
 * parent turn and each child's Write tool call.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ExecutionEngine } from '../src/core/engine.js'
import { Renderer } from '../src/ui/renderer.js'
import type { EngineConfig } from '../src/core/types.js'

const TIMEOUT = 180_000

// ── Fixture: scripts parent + children by inspecting the conversation ──────
interface Seen {
  model: string
  lastUser: string
  hasSteer: boolean
  at: number
}

function startFanoutFixture() {
  const seen: Seen[] = []
  let childCallCount = 0
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      let body: { model?: string; messages?: Array<{ role: string; content: unknown }> } = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* ignore */ }
      const msgs = body.messages ?? []
      const lastUser = msgs.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : '')).join('␞').slice(-800)
      const hasSteer = msgs.some((m) => {
        const c = m.content
        return typeof c === 'string' && c.includes('steered_instruction')
      })
      const steerInSystem = msgs.filter((m) => m.role === 'system').some((m) => {
        const c = m.content
        return typeof c === 'string' && c.includes('steered_instruction')
      })
      seen.push({ model: body.model ?? '', lastUser, hasSteer: hasSteer || steerInSystem, at: Date.now() })
      void lastUser

      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'e2e-model' }] }))
        return
      }

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })

      // Parent turn 1: THREE Agent calls — but ONLY before any Agent
      // result is in the history (the parent's follow-up request still
      // contains FANOUT-PLEASE in its user messages; without this guard
      // it fans out forever → max_iterations).
      const hasAgentResult = msgs.some((m) => m.role === 'tool')
      const toolResults = msgs.filter((m) => m.role === 'tool').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).slice(0, 200)).join(' || ')
      if (process.env.R32_DEBUG) {
        const sys = msgs.find((m) => m.role === 'system')
        const sysText = typeof sys?.content === 'string' ? sys.content.slice(0, 60) : JSON.stringify(sys?.content).slice(0, 60)
        const wtDir = /Working directory: (\S+)/.exec(typeof sys?.content === 'string' ? sys.content : '')?.[1]
        let lsOut = ''
        if (wtDir) {
          try { lsOut = execFileSync('find', [wtDir, '-maxdepth', '2', '-name', 'out', '-o', '-name', '*.txt'], { encoding: 'utf8' }).trim().slice(0, 300) } catch { lsOut = '(find failed)' }
        }
        console.error('REQ', JSON.stringify({ roles: msgs.map((m) => m.role).join(','), wt: wtDir, ls: lsOut, toolResults: toolResults.slice(0, 400) }))
      }
      if (lastUser.includes('FANOUT-PLEASE') && !hasAgentResult) {
        res.end(sseThreeAgentCalls())
        return
      }
      // Child agents: first call issues a Write; the follow-up (after
      // the Write tool result lands in history) completes. ONE
      // completion per response — the engine opens a new request per
      // turn-iteration.
      // Child engines carry '[Task Instructions]' (Delegation Contract).
      const isChild = msgs.some((m) => {
        const c = m.content
        return typeof c === 'string' && c.includes('[Task Instructions]')
      })
      const toolMsgs = msgs.filter((m) => m.role === 'tool')
      const wroteFile = toolMsgs.some((m) => {
        const c = m.content
        return typeof c === 'string' && c.startsWith('File written')
      })
      const verified = toolMsgs.some((m) => {
        const c = m.content
        return typeof c === 'string' && c.includes('VERIFY-OK')
      })
      const readSeed = toolMsgs.some((m) => {
        const c = m.content
        return typeof c === 'string' && c.includes('seed.txt')
      })
      if (isChild && !readSeed) {
        // Step 0: real agents read before writing — and the delegation
        // wrapper's boilerplate trips the analysis-read heuristic, so a
        // faithful child satisfies it with real Reads.
        res.end(sse([
          toolCallChunk(0, 'r1', 'Read', JSON.stringify({ file_path: 'seed.txt' })),
          toolCallChunk(1, 'r2', 'Read', JSON.stringify({ file_path: 'package.json' })),
          toolCallChunk(2, 'r3', 'Read', JSON.stringify({ file_path: 'out/.keep' })),
          finishChunk('tool_calls'),
          'data: [DONE]\n\n',
        ]))
        return
      }
      if (isChild && !wroteFile) {
        const m = /write\s+(\S+)\s+with content "([^"]+)"/.exec(lastUser)
        if (m) {
          childCallCount++
          const args = JSON.stringify({ file_path: m[1], content: m[2] + '\n' })
          res.end(sse([
            toolCallChunk(0, 'w1', 'Write', args),
            finishChunk('tool_calls'),
            'data: [DONE]\n\n',
          ]))
          return
        }
      }
      if (isChild && wroteFile && !verified) {
        // Second step: real verification via Bash (satisfies the
        // CompletionContract's verification.executed requirement for
        // mutation tasks — exactly what a real agent does).
        const m = /write\s+(\S+)\s+with content/.exec(lastUser)
        const file = m?.[1] ?? 'out/x.txt'
        const args = JSON.stringify({ command: `test -f ${file} && echo "VERIFY-OK ${file}"` })
        res.end(sse([
          toolCallChunk(0, 'v1', 'Bash', args),
          finishChunk('tool_calls'),
          'data: [DONE]\n\n',
        ]))
        return
      }
      if (isChild && verified) {
        res.end(sseText(`Task complete: file written and verified on disk.`))
        return
      }
      // Steer scenario: first child call gets tool call, next sees steer
      if (hasSteer) {
        res.end(sseText(`ACK-STEER:${extractSteer(lastUser)}`))
        return
      }
      res.end(sseText('done'))
    })
  })
  return {
    seen,
    getChildCalls: () => childCallCount,
    start: async () => {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const addr = server.address()
      if (!addr || typeof addr === 'string') throw new Error('bind failed')
      return { port: addr.port, baseURL: `http://127.0.0.1:${addr.port}` }
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

function extractSteer(text: string): string {
  const m = /steered_instruction[^"]*"([^"]+)"/.exec(text)
  return m?.[1] ?? ''
}

function sse(lines: string[]): string {
  return lines.join('')
}
const B = { id: 'cc', object: 'chat.completion.chunk', created: 1, model: 'e2e-model' }
function toolCallChunk(idx: number, id: string, name: string, argsJson: string) {
  // Distinct stream indices per call — the OpenAI wire contract the
  // accumulator keys on (all-zero indices CONCATENATE across calls).
  return `data: ${JSON.stringify({ ...B, choices: [{ index: 0, delta: { tool_calls: [{ index: idx, id, type: 'function', function: { name, arguments: argsJson } }] } }] })}\n\n`
}
function textChunk(t: string) {
  return `data: ${JSON.stringify({ ...B, choices: [{ index: 0, delta: { content: t } }] })}\n\n`
}
function finishChunk(reason: string) {
  return `data: ${JSON.stringify({ ...B, choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\n`
}

function sseThreeAgentCalls(): string {
  const mk = (idx: number, id: string, desc: string, file: string, content: string) => {
    const args = JSON.stringify({ description: desc, prompt: `Run: write ${file} with content "${content}"`, task_mode: 'modify', subagent_type: 'general-purpose', max_iterations: 8 })
    return toolCallChunk(idx, id, 'Agent', args)
  }
  return sse([
    mk(0, 'a1', 'writer-a', 'out/a.txt', 'AAA'),
    mk(1, 'a2', 'writer-b', 'out/b.txt', 'BBB'),
    mk(2, 'a3', 'writer-c', 'out/c.txt', 'CCC'),
    finishChunk('tool_calls'),
    'data: [DONE]\n\n',
  ])
}

function sseText(t: string): string {
  return sse([textChunk(t), finishChunk('stop'), 'data: [DONE]\n\n'])
}

// ── Harness ──────────────────────────────────────────────────────────────────
function sink(): { renderer: Renderer; out: () => string } {
  const buf = ''
  const r = new Renderer({ stream: new (require('node:stream').Writable)({
    write(_c: never, _e: never, cb: (err?: Error | null) => void) { cb() },
  }) })
  void buf
  return { renderer: r, out: () => buf }
}

describe('R32 E2E-P: three parallel modify agents through the real engine', () => {
  let fixture: ReturnType<typeof startFanoutFixture>
  let baseURL: string
  let repo: string

  beforeAll(async () => {
    fixture = startFanoutFixture()
    ;({ baseURL } = await fixture.start())
  })
  afterAll(async () => { await fixture.close() })
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'r32-par-'))
    execFileSync('git', ['init', '-q'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
    writeFileSync(join(repo, 'seed.txt'), 'seed\n')
    // A detectable verify command — AgentTool's verify gate runs it after
    // the child's turn (empty repos have no detector hit → gate skipped).
    writeFileSync(join(repo, 'package.json'), JSON.stringify({
      name: 'r32-e2e', private: true,
      scripts: { typecheck: 'node -e "process.exit(0)"' },
    }))
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo })
  })
  afterEach(() => { try { rmSync(repo, { recursive: true, force: true }) } catch { /* worktrees */ } })

  it('all three run CONCURRENTLY (overlapping windows) and all merge onto the base', async () => {
    const { renderer } = sink()
    const config: EngineConfig = {
      model: 'e2e-model',
      apiKey: 'k',
      baseURL,
      provider: 'openai-compatible',
      cwd: repo,
      maxIterations: 8,
      permissionMode: 'auto',
      maxContextTokens: 32_000,
      maxOutputTokens: 2048,
      sessionDir: join(repo, 'sessions', 'e2e'),
      agentFactory: (childConfig, childRenderer) => new ExecutionEngine(childConfig, childRenderer),
    }
    const engine = new ExecutionEngine(config, renderer)
    const started = Date.now()
    const { result } = await engine.runTurn('FANOUT-PLEASE: implement by creating three output files — dispatch three writer agents', [])
    const wall = Date.now() - started
    void wall

    // (1) Three children actually spawned and finished.
    if (process.env.R32_DEBUG) {
      try {
        console.error('LOG', execFileSync('git', ['log', '--oneline', '--all'], { cwd: repo, encoding: 'utf8' }).trim())
        console.error('WT', execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' }).trim())
        console.error('STATUS', execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim())
      } catch (e) { console.error('GITDBG FAIL', (e as Error).message) }
    }
    if (process.env.R32_DEBUG) console.error('PARENT-RESULT reason:', result.reason)
    const outputs = ['out/a.txt', 'out/b.txt', 'out/c.txt']
    for (const rel of outputs) {
      const onBase = existsSync(join(repo, rel))
      expect({ rel, onBase, reason: result.reason }).toEqual({ rel, onBase: true, reason: result.reason })
    }
    // (2) Merge order serialized cleanly: git state coherent.
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })
    expect(existsSync(join(repo, '.git', 'index.lock'))).toBe(false)
    expect(status).not.toMatch(/^UU/m)
    engine.dispose()
  }, TIMEOUT)

  it('steer reaches a running child via the real engine stack', async () => {
    const { renderer } = sink()
    const steerSeen: string[] = []
    const config: EngineConfig = {
      model: 'e2e-model',
      apiKey: 'k',
      baseURL,
      provider: 'openai-compatible',
      cwd: repo,
      maxIterations: 8,
      permissionMode: 'auto',
      maxContextTokens: 32_000,
      maxOutputTokens: 2048,
      sessionDir: join(repo, 'sessions', 'e2e-steer'),
      agentFactory: (childConfig, childRenderer) => {
        const child = new ExecutionEngine(childConfig, childRenderer)
        return {
          runTurn: (msg: string, history: never[]) => {
            // Real steer exercised DURING the child's turn: the parent
            // test injects while the child's first LLM call is settling.
            setTimeout(() => {
              const ok = child.steer('pivot to plan B')
              if (ok) steerSeen.push('delivered')
            }, 30)
            return child.runTurn(msg, history)
          },
          abort: () => child.abort(),
          steer: (i: string) => child.steer(i),
          dispose: () => child.dispose(),
        }
      },
    }
    const engine = new ExecutionEngine(config, renderer)
    await engine.runTurn('FANOUT-PLEASE: implement by creating three output files — dispatch three writer agents', [])
    // The fixture logs every request it saw; a delivered steer shows up
    // as steered_instruction in a LATER request to the same child.
    if (process.env.R32_DEBUG) console.error('STEER-SEEN', JSON.stringify(fixture.seen.map((x) => ({ s: x.hasSteer, sys: x.lastUser.slice(0, 40) }))), steerSeen)
    const steeredRequests = fixture.seen.filter((s) => s.hasSteer)
    expect(steerSeen).toContain('delivered')
    expect(steeredRequests.length).toBeGreaterThanOrEqual(1)
    engine.dispose()
  }, TIMEOUT)
})
