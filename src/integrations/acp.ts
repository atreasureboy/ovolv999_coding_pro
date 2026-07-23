/**
 * ACP Server — Agent Client Protocol over stdio.
 *
 * Enables editor integration (Zed, VSCode, Neovim) by exposing the
 * ovolv999 engine as a JSON-RPC server communicating over stdin/stdout.
 *
 * Protocol (line-delimited JSON-RPC 2.0):
 *   → {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
 *   ← {"jsonrpc":"2.0","id":1,"result":{"capabilities":{...}}}
 *
 *   → {"jsonrpc":"2.0","method":"message","params":{"text":"hello"}}
 *   ← {"jsonrpc":"2.0","method":"response","params":{"text":"...","done":false}}
 *   ← {"jsonrpc":"2.0","method":"response","params":{"text":"...","done":true}}
 *
 * Inspired by Claude Code's ACP implementation and the LSP specification.
 */

import { createInterface, type Interface as ReadlineInterface } from 'readline'
import { EventEmitter } from 'events'
import { writeFileSync, readFileSync } from 'fs'
import { resolve } from 'path'

// ── Types ───────────────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id?: string | number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification

export interface ACPCapabilities {
  streaming: boolean
  tools: boolean
  multiModal: boolean
  worktrees: boolean
  interrupts: boolean
}

export interface ACPHandlers {
  onMessage?: (text: string, images?: string[]) => Promise<string>
  onInterrupt?: () => void
  onFileRead?: (path: string) => string
  onFileWrite?: (path: string, content: string) => void
  onCost?: () => { inputTokens: number; outputTokens: number; totalCost: number }
}

// ── Error Codes ─────────────────────────────────────────────────────────────

export const RPC_ERRORS = {
  PARSE_ERROR:      { code: -32700, message: 'Parse error' },
  INVALID_REQUEST:  { code: -32600, message: 'Invalid request' },
  METHOD_NOT_FOUND: { code: -32601, message: 'Method not found' },
  INVALID_PARAMS:   { code: -32602, message: 'Invalid params' },
  INTERNAL_ERROR:   { code: -32603, message: 'Internal error' },
} as const

// ── Protocol Version ────────────────────────────────────────────────────────

export const ACP_VERSION = '0.1.0'
export const PROTOCOL_VERSION = '2025-07-20'

// ── Message Parsing ─────────────────────────────────────────────────────────

/**
 * Parse a single line as JSON-RPC.
 * Returns null if the line is empty or not valid JSON.
 */
export function parseMessage(line: string): JsonRpcMessage | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!isValidMessage(parsed)) return null
    return parsed as JsonRpcMessage
  } catch {
    return null
  }
}

function isValidMessage(obj: unknown): boolean {
  if (typeof obj !== 'object' || obj === null) return false
  const o = obj as Record<string, unknown>
  if (o.jsonrpc !== '2.0') return false
  // Request: has method
  // Response: has result or error, and id
  // Notification: has method, no id
  if (typeof o.method === 'string') return true // request or notification
  if ('result' in o || 'error' in o) return true // response
  return false
}

/**
 * Serialize a message to a JSON-RPC line.
 */
export function serializeMessage(msg: JsonRpcMessage): string {
  return JSON.stringify(msg)
}

// ── Response Builders ───────────────────────────────────────────────────────

export function okResponse(id: string | number | undefined, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

export function errorResponse(
  id: string | number | undefined,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, data } }
}

export function notification(method: string, params?: Record<string, unknown>): JsonRpcNotification {
  return { jsonrpc: '2.0', method, params }
}

// ── ACP Server ──────────────────────────────────────────────────────────────

export class ACPServer extends EventEmitter {
  private handlers: ACPHandlers
  private cwd: string
  private initialized = false
  private rl: ReadlineInterface | null = null
  private writeFn: (data: string) => void

  constructor(
    handlers: ACPHandlers,
    options: { cwd: string; write?: (data: string) => void },
  ) {
    super()
    this.handlers = handlers
    this.cwd = options.cwd
    this.writeFn = options.write ?? ((data: string) => process.stdout.write(data))
  }

  /** Get server capabilities */
  getCapabilities(): ACPCapabilities {
    return {
      streaming: true,
      tools: true,
      multiModal: true,
      worktrees: true,
      interrupts: true,
    }
  }

  /** Start listening on a readline interface (defaults to stdin) */
  start(input: NodeJS.ReadableStream = process.stdin): void {
    this.rl = createInterface({ input, terminal: false })

    this.rl.on('line', (line: string) => {
      const msg = parseMessage(line)
      if (msg) {
        this.handleMessage(msg).catch(err => {
          this.emit('error', err)
        })
      }
    })

    this.rl.on('close', () => {
      this.emit('close')
    })
  }

  /** Stop the server */
  stop(): void {
    this.rl?.close()
    this.rl = null
    this.initialized = false
  }

  /** Send a message to the client */
  send(msg: JsonRpcMessage): void {
    this.writeFn(serializeMessage(msg) + '\n')
  }

  /** Send a notification (no response expected) */
  notify(method: string, params?: Record<string, unknown>): void {
    this.send(notification(method, params))
  }

  /** Handle a single JSON-RPC message */
  async handleMessage(msg: JsonRpcMessage): Promise<void> {
    // Only handle requests and notifications (not responses from client)
    if (!('method' in msg)) return

    const req = msg
    const id = 'id' in req ? (req).id : undefined
    const { method, params } = req

    try {
      switch (method) {
        case 'initialize':
          this.initialized = true
          this.respond(id, {
            protocolVersion: PROTOCOL_VERSION,
            serverInfo: {
              name: 'ovolv999',
              version: ACP_VERSION,
            },
            capabilities: this.getCapabilities(),
            cwd: this.cwd,
          })
          break

        case 'shutdown':
          this.initialized = false
          this.respond(id, {})
          this.emit('shutdown')
          break

        case 'message':
          await this.handleMessageMethod(id, params)
          break

        case 'interrupt':
          this.handlers.onInterrupt?.()
          this.respond(id, { interrupted: true })
          break

        case 'file/read':
          this.handleFileRead(id, params)
          break

        case 'file/write':
          this.handleFileWrite(id, params)
          break

        case 'cost':
          if (this.handlers.onCost) {
            this.respond(id, this.handlers.onCost())
          } else {
            this.respondError(id, RPC_ERRORS.METHOD_NOT_FOUND.code, 'Cost tracking not available')
          }
          break

        default:
          if (id !== undefined) {
            this.respondError(id, RPC_ERRORS.METHOD_NOT_FOUND.code, `Unknown method: ${method}`)
          }
      }
    } catch (err) {
      if (id !== undefined) {
        this.respondError(id, RPC_ERRORS.INTERNAL_ERROR.code, (err as Error).message)
      }
      this.emit('error', err)
    }
  }

  private async handleMessageMethod(
    id: string | number | undefined,
    params?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.initialized) {
      this.respondError(id, RPC_ERRORS.INVALID_REQUEST.code, 'Server not initialized')
      return
    }

    if (!this.handlers.onMessage) {
      this.respondError(id, RPC_ERRORS.METHOD_NOT_FOUND.code, 'No message handler')
      return
    }

    const text = String(params?.text ?? '')
    const images = Array.isArray(params?.images) ? (params.images as string[]) : undefined

    if (!text) {
      this.respondError(id, RPC_ERRORS.INVALID_PARAMS.code, 'Missing "text" param')
      return
    }

    try {
      // Notify: message received
      this.notify('message/received', { text })

      // Process the message
      const response = await this.handlers.onMessage(text, images)

      // Send response
      this.respond(id, { text: response, done: true })

      // Also notify with streaming-like event
      this.notify('response', { text: response, done: true })
    } catch (err) {
      this.respondError(id, RPC_ERRORS.INTERNAL_ERROR.code, (err as Error).message)
    }
  }

  private handleFileRead(id: string | number | undefined, params?: Record<string, unknown>): void {
    if (!this.handlers.onFileRead) {
      // Default: read from filesystem
      const path = String(params?.path ?? '')
      if (!path) {
        this.respondError(id, RPC_ERRORS.INVALID_PARAMS.code, 'Missing "path"')
        return
      }
      try {
        const content = readFileSync(resolve(this.cwd, path), 'utf8')
        this.respond(id, { path, content })
      } catch (err) {
        this.respondError(id, RPC_ERRORS.INTERNAL_ERROR.code, `Failed to read: ${(err as Error).message}`)
      }
      return
    }

    const path = String(params?.path ?? '')
    if (!path) {
      this.respondError(id, RPC_ERRORS.INVALID_PARAMS.code, 'Missing "path"')
      return
    }
    const content = this.handlers.onFileRead(path)
    this.respond(id, { path, content })
  }

  private handleFileWrite(id: string | number | undefined, params?: Record<string, unknown>): void {
    const path = String(params?.path ?? '')
    const content = String(params?.content ?? '')

    if (!path) {
      this.respondError(id, RPC_ERRORS.INVALID_PARAMS.code, 'Missing "path"')
      return
    }

    if (this.handlers.onFileWrite) {
      this.handlers.onFileWrite(path, content)
    } else {
      try {
        writeFileSync(resolve(this.cwd, path), content, 'utf8')
      } catch (err) {
        this.respondError(id, RPC_ERRORS.INTERNAL_ERROR.code, `Failed to write: ${(err as Error).message}`)
        return
      }
    }

    this.respond(id, { path, written: true })
  }

  private respond(id: string | number | undefined, result: unknown): void {
    if (id === undefined) return // notification — no response
    this.send(okResponse(id, result))
  }

  private respondError(
    id: string | number | undefined,
    code: number,
    message: string,
    data?: unknown,
  ): void {
    if (id === undefined) return
    this.send(errorResponse(id, code, message, data))
  }
}
