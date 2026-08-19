import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ObservabilityServer, type EngineHandle } from '../src/server/httpServer.js'
import { RunEventEmitter } from '../src/core/runtime/events.js'
import { createSessionDir, saveSession } from '../src/core/sessionManager.js'

/**
 * Round 38 (opencode server architecture, observability slice): the
 * zero-dependency HTTP+SSE server exposes /health /sessions /session/<name>
 * and a live SSE stream of every RunEvent.
 */

let cwd = ''
let server: ObservabilityServer
let emitter: RunEventEmitter
let base = ''
let abort: AbortController

function fakeEngine(e: RunEventEmitter): EngineHandle {
  return {
    getEventEmitter: () => e,
    getModel: () => 'test-model',
    getProvider: () => 'openai',
  }
}

beforeEach(async () => {
  cwd = mkdtempSync(join(tmpdir(), 'ovogo-http-server-'))
  emitter = new RunEventEmitter()
  server = new ObservabilityServer({ cwd, port: 0 })
  await server.start()
  server.attachEngine(fakeEngine(emitter))
  const a = server.address!
  base = `http://${a.host}:${a.port}`
  abort = new AbortController()
})

afterEach(async () => {
  abort.abort()
  await server.stop()
  rmSync(cwd, { recursive: true, force: true })
})

describe('ObservabilityServer', () => {
  it('GET /health reports engine + version', async () => {
    const res = await fetch(`${base}/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    const engine = body.engine as Record<string, string>
    expect(engine.model).toBe('test-model')
    expect(engine.provider).toBe('openai')
    expect(typeof body.version).toBe('string')
  })

  it('GET /sessions lists sessions with persisted titles', async () => {
    const dir = createSessionDir(cwd)
    saveSession(dir, [{ role: 'user', content: 'hello' }], undefined, 'My Session')

    const res = await fetch(`${base}/sessions`)
    const body = (await res.json()) as { sessions: Array<{ name: string; title?: string }> }
    const found = body.sessions.find((s) => s.name === dir.split('/').pop())
    expect(found?.title).toBe('My Session')
  })

  it('GET /session/<name> returns metadata without messages', async () => {
    const dir = createSessionDir(cwd)
    saveSession(dir, [
      { role: 'user', content: 'fix the bug' },
      { role: 'assistant', content: 'done' },
    ])

    const name = dir.split('/').pop()!
    const res = await fetch(`${base}/session/${name}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.messages).toBe(2)
    expect(body.firstUserMessage).toBe('fix the bug')
    expect(body.messagesArray).toBeUndefined()
  })

  it('GET /session/<unknown> → 404', async () => {
    const res = await fetch(`${base}/session/nope-123`)
    expect(res.status).toBe(404)
  })

  it('GET /events streams live RunEvents over SSE', async () => {
    const res = await fetch(`${base}/events`, { signal: abort.signal })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    const readUntil = async (predicate: (s: string) => boolean): Promise<string> => {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) throw new Error('SSE stream closed early')
        buffer += decoder.decode(value, { stream: true })
        if (predicate(buffer)) return buffer
      }
    }

    // First: the hello event.
    await readUntil((s) => s.includes('event: hello'))

    // Emit a typed run event — it must arrive with its payload intact.
    emitter.emit({ type: 'MODEL_CHANGED', from: 'a', to: 'b' })
    const got = await readUntil((s) => s.includes('event: MODEL_CHANGED'))
    expect(got).toContain('"from":"a"')
    expect(got).toContain('"to":"b"')
  })

  it('unknown routes → 404 JSON', async () => {
    const res = await fetch(`${base}/nope`)
    expect(res.status).toBe(404)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toMatch(/no route/)
  })

  it('stop() closes the port', async () => {
    const s2 = new ObservabilityServer({ cwd, port: 0 })
    const { port } = await s2.start()
    await s2.stop()
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow()
  })
})
