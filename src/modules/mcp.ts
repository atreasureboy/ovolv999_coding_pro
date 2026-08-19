/**
 * McpModule — dynamically injects MCP server tools into the engine.
 *
 * At boot, reads `config.mcp.servers`, connects each stdio server, lists its
 * tools, and returns them (wrapped via McpToolAdapter) as module-provided
 * tools. The engine merges these into the tool set, so the LLM can call
 * `mcp__<server>__<tool>` like any built-in tool.
 *
 * Connection failures are isolated: one broken server logs a warning and is
 * skipped — it never blocks the boot sequence.
 *
 * Lifecycle: dispose() closes every connected stdio client so the server
 * processes don't outlive the engine. The engine calls this from its own
 * dispose() method (Engine.dispose → McpModule.dispose). Best-effort —
 * individual close failures are swallowed to keep shutdown robust. The
 * module's onComplete() is intentionally NOT used to close the clients,
 * because onComplete fires after every turn — closing there would sever
 * the connections between user prompts and break subsequent tool calls.
 */

import OpenAI from 'openai'
import type { AgentModule, ModuleBootContext, ModuleBootResult } from '../core/module.js'
import type { Tool, ToolContext } from '../core/types.js'
import {
  McpStdioClient,
  type McpServerConfig,
  type McpResourceInfo,
  type McpResourceContent,
  type McpPromptInfo,
  type McpSamplingRequest,
  type McpSamplingResult,
} from '../core/mcpClient.js'
import { McpHttpClient } from '../core/mcpHttpClient.js'
import { McpToolAdapter } from '../tools/mcpToolAdapter.js'

/**
 * Unified client surface for both stdio and HTTP MCP transports.
 * Both McpStdioClient and McpHttpClient satisfy this; the module holds
 * clients as this type so the resource/prompt tools can call them
 * without caring about transport.
 */
interface McpClient {
  connect(): Promise<void>
  close(): Promise<void>
  listTools(): Promise<Array<{ name: string; description?: string; inputSchema: unknown }>>
  callTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }>
  listResources(): Promise<McpResourceInfo[]>
  readResource(uri: string): Promise<McpResourceContent[]>
  listPrompts(): Promise<McpPromptInfo[]>
}

/**
 * Registry entry exposed to the resource/prompt tools via ToolContext.
 * The `client` field is the methods the tools need (narrowed from McpClient
 * so the tool doesn't depend on the full transport interface).
 */
export interface McpRegistryEntry {
  client: {
    listResources: () => Promise<McpResourceInfo[]>
    readResource: (uri: string) => Promise<McpResourceContent[]>
    listPrompts: () => Promise<McpPromptInfo[]>
  }
  serverName: string
}

export class McpModule implements AgentModule {
  readonly name = 'mcp'
  criticality = 'best_effort' as const

  private clients: McpClient[] = []
  /**
   * Name → registry entry for every connected server. Published into
   * ToolContext.mcpRegistry so the ListMcpResources / ReadMcpResource
   * tools can enumerate resources and prompts WITHOUT depending on the
   * concrete transport classes.
   */
  private registry = new Map<string, McpRegistryEntry>()

  async boot(ctx: ModuleBootContext): Promise<ModuleBootResult> {
    const servers = ctx.config.mcp?.servers ?? []
    if (servers.length === 0) return {}

    // MCP sampling (server→client completions) runs on the engine's active
    // transport. Built once per boot — every stdio server shares it. The
    // engine's /model + cross-provider switches are NOT tracked here (the
    // client is a boot snapshot); sampling is a best-effort convenience.
    const samplingHandler = this.buildSamplingHandler(ctx)

    const tools: Tool[] = []
    for (const server of servers) {
      try {
        const client = this.createClient(server, samplingHandler)
        await client.connect()
        const toolInfos = await client.listTools()
        this.clients.push(client)
        this.registry.set(server.name, {
          client: {
            listResources: () => client.listResources(),
            readResource: (uri: string) => client.readResource(uri),
            listPrompts: () => client.listPrompts(),
          },
          serverName: server.name,
        })
        for (const info of toolInfos) {
          tools.push(new McpToolAdapter(server.name, info, client))
        }
      } catch (err) {
        const detail = server.type === 'http' ? (server.url ?? '') : (server.command ?? []).join(' ')
        process.stderr.write(
          `[mcp] failed to connect server "${server.name}" (${detail}): ${(err as Error).message}\n`,
        )
      }
    }

    const toolContextPatch: Partial<ToolContext> = this.registry.size > 0
      ? { mcpRegistry: this.registry }
      : {}
    return tools.length > 0 || this.registry.size > 0
      ? { tools, toolContextPatch }
      : {}
  }

  private createClient(server: McpServerConfig, samplingHandler?: (params: McpSamplingRequest) => Promise<McpSamplingResult>): McpClient {
    if (server.type === 'http') {
      return new McpHttpClient(server)
    }
    return new McpStdioClient(server, samplingHandler ? { samplingHandler } : {})
  }

  /**
   * Build the sampling callback from the engine boot config. Maps MCP
   * message content (string or content-block array) onto chat-completion
   * text, honours maxTokens/temperature when provided, and answers in the
   * MCP content shape. Errors propagate to handleServerRequest, which turns
   * them into a JSON-RPC error response for the server.
   */
  private buildSamplingHandler(ctx: ModuleBootContext): ((params: McpSamplingRequest) => Promise<McpSamplingResult>) | undefined {
    const { apiKey, baseURL, model } = ctx.config
    if (!apiKey) return undefined
    const client = new OpenAI({ apiKey, baseURL, maxRetries: 2, timeout: 120_000 })

    return async (params: McpSamplingRequest): Promise<McpSamplingResult> => {
      const messages = (params.messages ?? [])
        .map((m) => {
          const role = m.role === 'assistant' ? 'assistant' : 'user'
          const text = typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? (m.content as Array<{ type?: string; text?: string }>)
                  .map((part) => (typeof part.text === 'string' ? part.text : ''))
                  .filter(Boolean)
                  .join('\n')
              : ''
          return { role, content: text } as const
        })
        .filter((m) => m.content.length > 0)
      if (messages.length === 0) {
        throw new Error('sampling request carried no usable messages')
      }
      const hinted = params.modelPreferences?.hints?.[0]?.name
      const completion = await client.chat.completions.create({
        model: (typeof hinted === 'string' && hinted.trim()) || model,
        messages,
        max_tokens: typeof params.maxTokens === 'number' && params.maxTokens > 0 ? params.maxTokens : 1024,
        ...(typeof params.temperature === 'number' ? { temperature: params.temperature } : {}),
      })
      const text = completion.choices[0]?.message?.content ?? ''
      return {
        role: 'assistant',
        content: { type: 'text', text },
        model: completion.model ?? model,
        stopReason: completion.choices[0]?.finish_reason ?? 'stop',
      }
    }
  }

  /**
   * Tear down connected MCP server processes. Without this hook the stdio
   * servers spawned at boot would outlive the engine and only exit when
   * the host process terminates — a process leak per MCP-equipped engine.
   * Best-effort: any close failure on an individual client is swallowed so
   * one stubborn server can't keep others alive. Idempotent.
   */
  async dispose(): Promise<void> {
    const clients = this.clients
    this.clients = []
    for (const client of clients) {
      try {
        await client.close()
      } catch {
        // best-effort cleanup — never let one stuck client block shutdown
      }
    }
  }
}

export type { McpServerConfig }
