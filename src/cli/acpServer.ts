/**
 * ACP WebSocket CLI entrypoint — wire `--acp-ws` flag to the
 * AcpWebSocketServer library. Zero deps; runs alongside the existing
 * stdio ACP transport.
 *
 * Each WebSocket connection gets its own ExecutionEngine instance, so
 * concurrent clients don't share state.
 */

import { writeFileSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import type { WebSocketACPTransport } from '../integrations/acpWebSocket.js';
import { AcpWebSocketServer } from '../integrations/acpWebSocket.js'
import { ACPServer } from '../integrations/acp.js'
import type { ACPHandlers } from '../integrations/acp.js'
import type { ExecutionEngine } from '../core/engine.js'
import type { OpenAIMessage } from '../core/types.js'
import { loadHookConfig } from '../core/hooks/hooksConfig.js'

export interface AcpWsCliOptions {
  port: number
  host: string
  cwd: string
  apiKey: string | undefined
  model: string | undefined
  baseURL: string | undefined
  provider: string | undefined
}

export function getAcpWsHelp(): string {
  return `ovolv999 --acp-ws <PORT> [--acp-ws-bind <HOST>]

Run ovolv999 as an ACP WebSocket server (RFC 6455). Same JSON-RPC 2.0
protocol as the stdio ACP transport, but on ws:// so browsers / dashboards
/ Python clients can drive the engine.

  --acp-ws <PORT>       Bind to this port (1-65535).
  --acp-ws-bind <HOST>  Bind to this host (default: 127.0.0.1).
  --cwd <DIR>           Project working directory.
  --model <MODEL>       LLM model id (defaults to OVOGO_MODEL).
  --base-url <URL>      LLM API base URL.
  --provider <PROVIDER> LLM provider id (openai, minimax, anthropic, ...).

Health check:
  curl http://HOST:PORT/health
  → {"ok":true,"connections":N}

Example browser client:
  const ws = new WebSocket('ws://127.0.0.1:8765/?token=<TOKEN>')
  ws.onopen = () => ws.send(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { clientInfo: { name: 'browser', version: '1.0' } },
  }))
`
}

export async function startAcpWebSocketServer(opts: AcpWsCliOptions): Promise<void> {
  if (!opts.apiKey) {
    process.stderr.write('Error: --acp-ws requires an API key (set OPENAI_API_KEY / ANTHROPIC_API_KEY)\n')
    process.exit(1)
  }

  const authToken = process.env.OVOGO_ACP_WS_TOKEN?.trim() || randomBytes(32).toString('hex')

  const onInterrupt = (): void => {
    process.stderr.write('[acp-ws] interrupt received\n')
  }
  const onFileRead = (path: string): string => {
    try { return readFileSync(path, 'utf8') } catch { return '' }
  }
  const onFileWrite = (path: string, content: string): void => {
    try { writeFileSync(path, content, 'utf8') }
    catch (err) { process.stderr.write(`[acp-ws] file/write failed: ${(err as Error).message}\n`) }
  }

  const server = new AcpWebSocketServer({
    port: opts.port,
    host: opts.host,
    authToken,
    onConnection: (transport: WebSocketACPTransport) => {
      // Per-connection engine + history: ACP is session-oriented, so
      // successive messages on one connection must see prior turns. A
      // fresh engine per message made every prompt a context-free
      // single turn — inconsistent with every other transport.
      let engine: { runTurn: ExecutionEngine['runTurn']; dispose?: () => void } | null = null
      const history: OpenAIMessage[] = []

      const handlers: ACPHandlers = {
        onMessage: async (text: string, images?: string[]) => {
          if (!engine) {
            const { ExecutionEngine } = await import('../core/engine.js')
            const { Renderer } = await import('../ui/renderer.js')
            const { DefaultHookRunner } = await import('../core/hooks/defaultRunner.js')
            const hookRunner = new DefaultHookRunner({
              cwd: opts.cwd,
              includeProject: process.env.OVOGO_TRUST_PROJECT_CODE === '1',
              configOverride: loadHookConfig(opts.cwd, process.env.OVOGO_TRUST_PROJECT_CODE === '1') ?? {},
            })
            const renderer = new Renderer({ stream: process.stderr })
            engine = new ExecutionEngine(
              {
                cwd: opts.cwd,
                apiKey: opts.apiKey!,
                baseURL: opts.baseURL,
                provider: opts.provider,
                model: opts.model ?? 'gpt-4o',
                permissionMode: 'auto',
                maxIterations: 50,
                hookRunner,
              },
              renderer,
            )
          }
          const imageInput = images?.map((dataUrl, i) => ({ path: `acp-image-${i}`, dataUrl }))
          const { result, newHistory } = await engine.runTurn(text, history, imageInput)
          history.splice(0, history.length, ...newHistory)
          return result.output ?? ''
        },
        onInterrupt,
        onFileRead,
        onFileWrite,
      }

      const acpServer = new ACPServer(handlers, {
        cwd: opts.cwd,
        write: (data: string) => transport.send(data),
      })
      transport.onMessage((frame: string) => {
        acpServer.handleFrame(frame).catch((err: unknown) => {
          process.stderr.write(`[acp-ws] handler error: ${(err as Error).message}\n`)
        })
      })
      transport.onClose(() => {
        acpServer.stop()
        try { engine?.dispose?.() } catch { /* best-effort teardown */ }
        engine = null
      })
    },
  })

  const port = await server.start()
  process.stderr.write(`[acp-ws] listening on ws://${opts.host}:${port}\n`)
  process.stderr.write(`[acp-ws] connect with ws://${opts.host}:${port}/?token=${authToken}\n`)
  process.stderr.write(`[acp-ws] health check: http://${opts.host}:${port}/health\n`)

  const shutdown = (): void => {
    void server.stop().catch(() => { /* best-effort shutdown */ }).finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
