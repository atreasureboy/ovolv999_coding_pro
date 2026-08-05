/**
 * ACP WebSocket CLI entrypoint — wire `--acp-ws` flag to the
 * AcpWebSocketServer library. Zero deps; runs alongside the existing
 * stdio ACP transport.
 *
 * Each WebSocket connection gets its own ExecutionEngine instance, so
 * concurrent clients don't share state.
 */

import { writeFileSync, readFileSync } from 'node:fs'
import type { WebSocketACPTransport } from '../integrations/acpWebSocket.js';
import { AcpWebSocketServer } from '../integrations/acpWebSocket.js'
import { ACPServer } from '../integrations/acp.js'
import type { ACPHandlers } from '../integrations/acp.js'

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
  return `ovolv999 --acp-ws --port <PORT> [--acp-ws-bind <HOST>]

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
  const ws = new WebSocket('ws://127.0.0.1:8765')
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

  const handlers: ACPHandlers = {
    onMessage: async (text: string) => {
      const { ExecutionEngine } = await import('../core/engine.js')
      const { Renderer } = await import('../ui/renderer.js')
      const { DefaultHookRunner } = await import('../core/hooks/defaultRunner.js')
      const hookRunner = new DefaultHookRunner({ cwd: opts.cwd })
      const renderer = new Renderer({ stream: process.stderr })
      const engine = new ExecutionEngine(
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
      try {
        const { result } = await engine.runTurn(text, [])
        return result.output ?? ''
      } finally {
        if (engine.dispose) engine.dispose()
      }
    },
    onInterrupt: () => {
      process.stderr.write('[acp-ws] interrupt received\n')
    },
    onFileRead: (path: string) => {
      try { return readFileSync(path, 'utf8') } catch { return '' }
    },
    onFileWrite: (path: string, content: string) => {
      try { writeFileSync(path, content, 'utf8') }
      catch (err) { process.stderr.write(`[acp-ws] file/write failed: ${(err as Error).message}\n`) }
    },
  }

  const server = new AcpWebSocketServer({
    port: opts.port,
    host: opts.host,
    onConnection: (transport: WebSocketACPTransport) => {
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
      })
    },
  })

  const port = await server.start()
  process.stderr.write(`[acp-ws] listening on ws://${opts.host}:${port}\n`)
  process.stderr.write(`[acp-ws] health check: http://${opts.host}:${port}/health\n`)

  const shutdown = (): void => {
    void server.stop().finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
