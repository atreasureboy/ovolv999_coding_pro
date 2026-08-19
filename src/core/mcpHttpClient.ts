/**
 * McpHttpClient — minimal HTTP transport for MCP servers (with OAuth).
 *
 * Implements just enough of the MCP spec to connect to an HTTP server
 * (with optional OAuth bearer token), list its tools, and invoke them.
 * Transport is JSON-RPC 2.0 over HTTP POST.
 *
 * Scope (v1): HTTP transport + tools protocol. NOT implemented: SSE
 * streaming, sampling, resources/prompts protocols.
 */

import type { McpServerConfig, McpToolInfo, McpResourceInfo, McpResourceContent, McpPromptInfo } from './mcpClient.js'
import { getValidToken } from '../integrations/mcpOAuth.js'

export interface McpHttpClientOptions {
  /** Override the fetch implementation (for tests). */
  fetchImpl?: typeof fetch
  /** Per-request timeout in ms (default 60s). 0 disables. */
  timeoutMs?: number
}

interface JsonRpcRequest {
  jsonrpc: '2.0'
  /** Absent for notifications (no response expected). */
  id?: number | string
  method: string
  params?: Record<string, unknown>
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
/** Matches McpStdioClient — a single protocol version across transports. */
const PROTOCOL_VERSION = '2024-11-05'
const INITIALIZE_TIMEOUT_MS = 60_000

interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0'
  id?: number | string
  result?: T
  error?: { code: number; message: string; data?: unknown }
}

interface InitializeResult {
  protocolVersion?: string
  capabilities?: Record<string, unknown>
  serverInfo?: { name?: string; version?: string }
}

export class McpHttpClient {
  private nextId = 1
  private connected = false
  /**
   * Streamable-HTTP session id (MCP spec 2025-03-26): servers answer
   * initialize with an `mcp-session-id` header that every subsequent
   * request must echo. Captured during connect() when present.
   */
  private sessionId: string | undefined
  /** Server-reported identity from the initialize handshake. */
  private serverInfo: { name?: string; version?: string } | undefined

  constructor(
    private readonly server: McpServerConfig,
    private readonly opts: McpHttpClientOptions = {},
  ) {}

  get isConnected(): boolean {
    return this.connected
  }

  /** Identity reported by the server during initialize (undefined pre-connect). */
  getServerInfo(): { name?: string; version?: string } | undefined {
    return this.serverInfo
  }

  /**
   * Real MCP initialize handshake (previously a flag-only no-op, so HTTP
   * servers that validate the handshake rejected every tools/list).
   * Sequence mirrors the stdio client: initialize → notifications/initialized.
   * Connection failures (DNS, auth, protocol mismatch) surface here so
   * McpModule can isolate and report them at boot.
   */
  async connect(): Promise<void> {
    if (this.connected) return
    if (this.server.type !== 'http') {
      throw new Error(`McpHttpClient cannot connect to non-http server "${this.server.name}"`)
    }
    if (!this.server.url) {
      throw new Error(`McpHttpClient: server "${this.server.name}" missing url`)
    }

    const result = await this.post<InitializeResult>(
      {
        jsonrpc: '2.0',
        id: this.nextId++,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'ovolv999', version: '0.1.0' },
        },
      },
      { expectResponse: true, timeoutMs: INITIALIZE_TIMEOUT_MS },
    )
    if (!result || typeof result !== 'object') {
      throw new Error(`MCP HTTP ${this.server.name}: initialize returned no result`)
    }
    this.serverInfo = result.serverInfo
    try {
      await this.post(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { expectResponse: false },
      )
    } catch {
      // Some servers reject the initialized notification over stateless
      // HTTP — tools/list still works, so treat as best-effort.
    }
    this.connected = true
  }

  private getFetch(): typeof fetch {
    return this.opts.fetchImpl ?? fetch
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    }
    if (this.server.headers) {
      for (const [k, v] of Object.entries(this.server.headers)) {
        headers[k] = v
      }
    }
    return headers
  }

  private async getAuthHeader(): Promise<Record<string, string>> {
    if (!this.server.oauth) return {}
    if (!this.server.oauth.clientId || !this.server.oauth.tokenEndpoint) {
      return {}
    }
    try {
      const token = await getValidToken(this.server.name, {
        serverId: this.server.name,
        authorizationEndpoint: this.server.oauth.authorizationEndpoint,
        tokenEndpoint: this.server.oauth.tokenEndpoint,
        clientId: this.server.oauth.clientId,
        clientSecret: this.server.oauth.clientSecret,
        scope: this.server.oauth.scope,
        redirectUri: this.server.oauth.redirectUri,
      }, this.getFetch())
      return { authorization: `Bearer ${token}` }
    } catch (err) {
      throw new Error(
        `MCP OAuth for "${this.server.name}" failed: ${(err as Error).message}. ` +
        'Run `ovolv999 mcp auth ' + this.server.name + '` to authorize.',
        { cause: err },
      )
    }
  }

  private async call<T>(
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.connected) {
      throw new Error(`McpHttpClient "${this.server.name}" not connected`)
    }
    const body: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: this.nextId++,
      method,
      params,
    }
    return this.post<T>(body, { expectResponse: true, signal })
  }

  /**
   * Low-level JSON-RPC POST shared by connect() and call(). Handles auth
   * headers, the streamable-HTTP session id, deadlines, and both plain
   * JSON and SSE (`text/event-stream`) response bodies — some MCP HTTP
   * servers answer initialize/tools requests via SSE even without
   * streaming enabled.
   */
  private async post<T>(
    body: JsonRpcRequest,
    options: { expectResponse: boolean; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<T> {
    if (!this.server.url) {
      throw new Error(`McpHttpClient "${this.server.name}" missing url`)
    }
    const authHeader = await this.getAuthHeader()
    const headers: Record<string, string> = {
      ...this.getHeaders(),
      ...authHeader,
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      // Servers that support SSE advertise it; we accept both shapes.
      accept: 'application/json, text/event-stream',
    }
    const timeoutMs = options.timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const signal = options.signal
    // Compose turn-abort + per-request timeout into one signal so ESC
    // cancels in-flight HTTP MCP calls too.
    let requestSignal: AbortSignal | undefined
    if (signal && timeoutMs > 0) {
      const composite = new AbortController()
      const abort = (reason?: unknown): void =>
        composite.abort(
          reason instanceof Error ? reason : new Error(`MCP HTTP ${this.server.name} ${body.method} aborted`),
        )
      signal.addEventListener('abort', () => abort(signal.reason), { once: true })
      const timeoutSignal = AbortSignal.timeout(timeoutMs)
      timeoutSignal.addEventListener('abort', () => abort(timeoutSignal.reason), { once: true })
      requestSignal = composite.signal
    } else {
      requestSignal = signal ?? (timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined)
    }
    const response = await this.getFetch()(this.server.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      // A dead/slow HTTP MCP server previously hung boot forever — every
      // request now carries a hard deadline.
      ...(requestSignal ? { signal: requestSignal } : {}),
    })

    // Capture the streamable-HTTP session id on any response that carries
    // it (spec: issued on initialize, must be echoed afterwards).
    const sid = response.headers.get('mcp-session-id')
    if (sid) this.sessionId = sid

    if (!response.ok) {
      throw new Error(
        `MCP HTTP ${this.server.name} ${body.method} failed: ${response.status} ${response.statusText}`,
      )
    }
    if (!options.expectResponse) {
      // Notifications: 202-style empty replies are the norm; discard any
      // body without parsing so a chatty server can't break connect().
      return undefined as T
    }

    const contentType = response.headers.get('content-type') ?? ''
    const rawText = await response.text()
    const json = (contentType.includes('text/event-stream')
      ? this.parseSseResponse(rawText, body.id)
      : this.parseJsonResponse(rawText)) as JsonRpcResponse<T> | null
    if (!json) {
      throw new Error(`MCP HTTP ${this.server.name} ${body.method}: empty or unparseable response`)
    }
    if (json.error) {
      throw new Error(`MCP HTTP ${this.server.name} ${body.method}: ${json.error.message}`)
    }
    return json.result as T
  }

  private parseJsonResponse(raw: string): JsonRpcResponse | null {
    if (!raw.trim()) return null
    try {
      return JSON.parse(raw) as JsonRpcResponse
    } catch {
      return null
    }
  }

  /**
   * Extract the JSON-RPC response for `id` from an SSE body. Each event
   * block's `data:` lines are parsed independently; a matching id wins,
   * and the first complete message is returned when no id matches
   * (single-shot responses from servers that ignore ids).
   */
  private parseSseResponse(raw: string, id: number | string | undefined): JsonRpcResponse | null {
    let first: JsonRpcResponse | null = null
    for (const block of raw.split(/\r?\n\r?\n/)) {
      const dataLines = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
      if (dataLines.length === 0) continue
      const parsed = this.parseJsonResponse(dataLines.join('\n'))
      if (!parsed) continue
      if (id !== undefined && parsed.id === id) return parsed
      first = first ?? parsed
    }
    return first
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = await this.call<{ tools: McpToolInfo[] }>('tools/list', {})
    return result.tools
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<{ content: string; isError: boolean }> {
    const result = await this.call<{ content: unknown; isError?: boolean }>(
      'tools/call',
      { name, arguments: args },
      options?.signal,
    )
    const rawContent = result?.content
    const contentArr: unknown[] = Array.isArray(rawContent) ? rawContent : []
    const text = contentArr
      .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
      .map((c) => (typeof c.text === 'string' ? c.text : ''))
      .filter((t) => t.length > 0)
      .join('\n')
    return { content: text, isError: result?.isError === true }
  }

  async close(): Promise<void> {
    this.connected = false
    this.sessionId = undefined
    this.serverInfo = undefined
  }

  /** List resources exposed by the HTTP server (best-effort — 404 → empty). */
  async listResources(): Promise<McpResourceInfo[]> {
    try {
      const result = await this.call<{ resources?: unknown }>('resources/list', {})
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
    const result = await this.call<{ contents?: unknown }>('resources/read', { uri })
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

  /** List prompts exposed by the HTTP server (best-effort — 404 → empty). */
  async listPrompts(): Promise<McpPromptInfo[]> {
    try {
      const result = await this.call<{ prompts?: unknown }>('prompts/list', {})
      const prompts = (result?.prompts ?? []) as unknown[]
      return prompts
        .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
        .map((p) => ({
          name: typeof p.name === 'string' ? p.name : '',
          description: typeof p.description === 'string' ? p.description : undefined,
          arguments: Array.isArray(p.arguments)
            ? (p.arguments as Array<{ name: string; description?: string; required?: boolean }>)
            : undefined,
        }))
        .filter((p) => p.name.length > 0)
    } catch {
      return []
    }
  }
}
