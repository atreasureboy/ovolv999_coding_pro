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

import type { McpServerConfig, McpToolInfo } from './mcpClient.js'
import { getValidToken } from '../integrations/mcpOAuth.js'

export interface McpHttpClientOptions {
  /** Override the fetch implementation (for tests). */
  fetchImpl?: typeof fetch
}

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0'
  id?: number | string
  result?: T
  error?: { code: number; message: string; data?: unknown }
}

export class McpHttpClient {
  private nextId = 1
  private connected = false

  constructor(
    private readonly server: McpServerConfig,
    private readonly opts: McpHttpClientOptions = {},
  ) {}

  get isConnected(): boolean {
    return this.connected
  }

  async connect(): Promise<void> {
    if (this.server.type !== 'http') {
      throw new Error(`McpHttpClient cannot connect to non-http server "${this.server.name}"`)
    }
    if (!this.server.url) {
      throw new Error(`McpHttpClient: server "${this.server.name}" missing url`)
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
      )
    }
  }

  private async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.connected || !this.server.url) {
      throw new Error(`McpHttpClient "${this.server.name}" not connected`)
    }
    const body: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: this.nextId++,
      method,
      params,
    }
    const authHeader = await this.getAuthHeader()
    const headers = { ...this.getHeaders(), ...authHeader }
    const response = await this.getFetch()(this.server.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      throw new Error(
        `MCP HTTP ${this.server.name} ${method} failed: ${response.status} ${response.statusText}`,
      )
    }
    const json = (await response.json()) as JsonRpcResponse<T>
    if (json.error) {
      throw new Error(`MCP HTTP ${this.server.name} ${method}: ${json.error.message}`)
    }
    return json.result as T
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = await this.call<{ tools: McpToolInfo[] }>('tools/list', {})
    return result.tools
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.call<{ content: unknown; isError?: boolean }>(
      'tools/call',
      { name, arguments: args },
    )
    return result
  }

  async close(): Promise<void> {
    this.connected = false
  }
}
