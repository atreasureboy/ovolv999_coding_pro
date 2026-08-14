/**
 * McpStdioClient — minimal MCP (Model Context Protocol) stdio client.
 *
 * Implements just enough of the MCP spec to connect to a stdio server,
 * list its tools, and invoke them. Transport is newline-delimited
 * JSON-RPC 2.0 over the server process's stdin/stdout.
 *
 * Scope (v1): stdio transport + tools + resources + prompts protocol.
 *   NOT implemented: sampling, SSE/HTTP transport.
 * The interface is intentionally narrow so a future iteration can swap in
 * the official @modelcontextprotocol/sdk without touching call sites.
 */

import { spawn, type ChildProcess } from 'child_process'

export interface McpServerConfig {
  /** Logical name; used to namespace tool names (mcp__<name>__<tool>) */
  name: string
  /** Transport type. v0.5 supports 'stdio' + 'http' (with OAuth). */
  type: 'stdio' | 'http'
  /** stdio-only: Command vector: command[0] is the executable, rest are args. */
  command?: string[]
  /** http-only: server URL. */
  url?: string
  /** Optional HTTP headers (e.g. for static auth tokens). */
  headers?: Record<string, string>
  /** Optional env overrides merged onto process.env (stdio only). */
  env?: Record<string, string>
  /** Optional working directory for the server process (stdio only). */
  cwd?: string
  /** http+oauth: OAuth config. When set, an Authorization: Bearer header is attached. */
  oauth?: {
    authorizationEndpoint: string
    tokenEndpoint: string
    clientId: string
    clientSecret?: string
    scope?: string
    redirectUri: string
  }
}

export interface McpToolInfo {
  name: string
  description?: string
  /** JSON Schema describing the tool's arguments. */
  inputSchema: unknown
}

export interface McpResourceInfo {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

export interface McpResourceContent {
  uri: string
  mimeType?: string
  text?: string
  blob?: string
}

export interface McpPromptInfo {
  name: string
  description?: string
  arguments?: Array<{ name: string; description?: string; required?: boolean }>
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  /** Turn-abort detach — removed when the request settles normally. */
  detachAbort?: () => void
}

const PROTOCOL_VERSION = '2024-11-05'
const DEFAULT_TIMEOUT_MS = 30_000
const INITIALIZE_TIMEOUT_MS = 60_000

export class McpStdioClient {
  private proc: ChildProcess | null = null
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private stdoutBuf = ''
  private stderrBuf = ''
  private closed = false
  private closePromise: Promise<void> | null = null

  constructor(private readonly server: McpServerConfig) {}

  /** Spawn the server and run the MCP initialize handshake. */
  async connect(): Promise<void> {
    if (this.proc) return
    if (this.server.type !== 'stdio') {
      throw new Error(`McpStdioClient cannot connect to non-stdio server "${this.server.name}"`)
    }
    const cmd = this.server.command ?? []
    if (cmd.length === 0) {
      throw new Error(`MCP server "${this.server.name}": empty command`)
    }

    const env = { ...process.env, ...(this.server.env ?? {}) }
    this.proc = spawn(cmd[0], cmd.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      cwd: this.server.cwd,
    })

    this.proc.stdout?.setEncoding('utf8')
    this.proc.stderr?.setEncoding('utf8')

    this.proc.stdout?.on('data', (chunk: string) => this.onStdout(chunk))
    this.proc.stderr?.on('data', (chunk: string) => {
      this.stderrBuf += chunk
      if (this.stderrBuf.length > 8192) this.stderrBuf = this.stderrBuf.slice(-8192)
    })

    this.proc.on('exit', (code, signal) => {
      const err = new Error(
        `MCP server "${this.server.name}" exited (code=${code} signal=${signal})` +
          (this.stderrBuf.trim() ? `\n${this.stderrBuf.trim().slice(-1024)}` : ''),
      )
      this.failAll(err)
    })
    this.proc.on('error', (err) => this.failAll(err))

    // Initialize handshake
    await this.request(
      {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'ovolv999', version: '0.1.0' },
        },
      },
      INITIALIZE_TIMEOUT_MS,
    )

    // Notify initialized (no id, no response expected)
    this.notify({ jsonrpc: '2.0', method: 'notifications/initialized' })
  }

  /** List tools exposed by the server. */
  async listTools(): Promise<McpToolInfo[]> {
    const result = (await this.request({
      jsonrpc: '2.0',
      method: 'tools/list',
    })) as { tools?: unknown } | null
    const tools = (result?.tools ?? []) as unknown[]
    return tools
      .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
      .map((t) => ({
        name: typeof t.name === 'string' ? t.name : '',
        description: typeof t.description === 'string' ? t.description : undefined,
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      }))
      .filter((t) => t.name.length > 0)
  }

  /** Invoke a tool by name. Returns concatenated text content + isError flag. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<{ content: string; isError: boolean }> {
    const result = (await this.request(
      {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name, arguments: args },
      },
      DEFAULT_TIMEOUT_MS,
      options?.signal,
    )) as { content?: unknown; isError?: boolean } | null

    const rawContent = result?.content
    const contentArr: unknown[] = Array.isArray(rawContent) ? rawContent : []
    const text = contentArr
      .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
      .map((c) => (typeof c.text === 'string' ? c.text : ''))
      .filter((t) => t.length > 0)
      .join('\n')

    return { content: text, isError: result?.isError === true }
  }

  /** List resources exposed by the server. */
  async listResources(): Promise<McpResourceInfo[]> {
    try {
      const result = (await this.request({
        jsonrpc: '2.0',
        method: 'resources/list',
      })) as { resources?: unknown } | null
      const resources = (result?.resources ?? []) as unknown[]
      return resources
        .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
        .map((r) => ({
          uri: typeof r.uri === 'string' ? r.uri : '',
          name: typeof r.name === 'string' ? r.name : undefined,
          description: typeof r.description === 'string' ? r.description : undefined,
          mimeType: typeof r.mimeType === 'string' ? r.mimeType : undefined,
        }))
        .filter((r) => r.uri.length > 0)
    } catch {
      return []
    }
  }

  /** Read a resource by URI. */
  async readResource(uri: string): Promise<McpResourceContent[]> {
    const result = (await this.request({
      jsonrpc: '2.0',
      method: 'resources/read',
      params: { uri },
    })) as { contents?: unknown } | null

    const rawContents = result?.contents
    const arr: unknown[] = Array.isArray(rawContents) ? rawContents : []
    return arr
      .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
      .map((c) => ({
        uri: typeof c.uri === 'string' ? c.uri : uri,
        mimeType: typeof c.mimeType === 'string' ? c.mimeType : undefined,
        text: typeof c.text === 'string' ? c.text : undefined,
        blob: typeof c.blob === 'string' ? c.blob : undefined,
      }))
  }

  /** List prompts exposed by the server. */
  async listPrompts(): Promise<McpPromptInfo[]> {
    try {
      const result = (await this.request({
        jsonrpc: '2.0',
        method: 'prompts/list',
      })) as { prompts?: unknown } | null
      const prompts = (result?.prompts ?? []) as unknown[]
      return prompts
        .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
        .map((p) => ({
          name: typeof p.name === 'string' ? p.name : '',
          description: typeof p.description === 'string' ? p.description : undefined,
          arguments: Array.isArray(p.arguments) ? (p.arguments as Array<{ name: string; description?: string; required?: boolean }>) : undefined,
        }))
        .filter((p) => p.name.length > 0)
    } catch {
      return []
    }
  }

  /** Tear down the connection. Idempotent. Waits (bounded) for the child
   *  to actually exit and escalates to SIGKILL — a server that traps or
   *  ignores SIGTERM would otherwise survive as an orphan whose stdio
   *  pipes pin the host's event loop. */
  close(): Promise<void> {
    if (this.closed) return this.closePromise ?? Promise.resolve()
    this.closed = true
    this.failAll(new Error('MCP client closed'))

    const proc = this.proc
    this.proc = null
    if (proc) {
      try {
        proc.stdin?.end()
      } catch {
        // ignore
      }
      if (proc.exitCode === null && proc.pid !== undefined) {
        try {
          proc.kill('SIGTERM')
        } catch {
          // ignore
        }
        // Bounded wait + SIGKILL escalation. The escalation timer is
        // unref'd so it cannot keep the host alive by itself; the child
        // exiting clears it.
        this.closePromise = new Promise<void>((resolve) => {
          const killTimer = setTimeout(() => {
            try {
              if (proc.exitCode === null) proc.kill('SIGKILL')
            } catch {
              // ignore — already gone
            }
            resolve()
          }, 3000)
          killTimer.unref?.()
          proc.once('exit', () => {
            clearTimeout(killTimer)
            resolve()
          })
          proc.once('error', () => {
            clearTimeout(killTimer)
            resolve()
          })
        })
      }
    }
    return this.closePromise ?? Promise.resolve()
  }

  // ── internals ───────────────────────────────────────────────────────────

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk
    let nl = this.stdoutBuf.indexOf('\n')
    while (nl !== -1) {
      const line = this.stdoutBuf.slice(0, nl).trim()
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1)
      nl = this.stdoutBuf.indexOf('\n')
      if (line.length === 0) continue
      this.handleMessage(line)
    }
  }

  private handleMessage(line: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      // Not valid JSON — ignore (some servers emit human logs on stdout by mistake)
      return
    }
    // Response to a request we sent
    if (typeof msg.id === 'number') {
      const pending = this.pending.get(msg.id)
      if (!pending) return
      clearTimeout(pending.timer)
      pending.detachAbort?.()
      this.pending.delete(msg.id)
      if (msg.error !== undefined) {
        const e = msg.error as Record<string, unknown>
        const errMsg = typeof e.message === 'string' ? e.message : JSON.stringify(msg.error)
        pending.reject(new Error(`MCP error: ${errMsg}`))
      } else {
        pending.resolve(msg.result)
      }
    }
    // Notifications / server-initiated messages: ignored in v1.
  }

  private send(message: object): void {
    if (!this.proc?.stdin || this.closed) {
      throw new Error(`MCP server "${this.server.name}": not connected`)
    }
    this.proc.stdin.write(JSON.stringify(message) + '\n')
  }

  private notify(message: object): void {
    this.send(message)
  }

  private request(
    message: object,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.closed) {
        reject(new Error(`MCP server "${this.server.name}": not connected`))
        return
      }
      const id = this.nextId++
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`MCP request id=${id} timed out after ${timeoutMs}ms (${this.server.name})`))
        }
      }, timeoutMs)
      // Pending-request timers must not delay process exit on their own —
      // the owning request promise keeps the relevant work alive.
      timer.unref?.()
      // Turn-abort: ESC/hard-abort must cancel in-flight MCP calls, not
      // leave the stdio pipe busy until its own timeout fires.
      const onAbort = (): void => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new Error(`MCP request id=${id} aborted (${this.server.name})`))
      }
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer)
          reject(new Error(`MCP request id=${id} aborted (${this.server.name})`))
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      const detachAbort = (): void => {
        if (signal) signal.removeEventListener('abort', onAbort)
      }
      this.pending.set(id, { resolve, reject, timer, detachAbort })
      try {
        this.send({ jsonrpc: '2.0', id, ...message })
      } catch (err) {
        clearTimeout(timer)
        detachAbort()
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error('MCP send failed'))
      }
    })
  }

  private failAll(err: Error): void {
    if (this.closed && this.pending.size === 0) return
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.detachAbort?.()
      p.reject(err)
    }
    this.pending.clear()
  }
}
