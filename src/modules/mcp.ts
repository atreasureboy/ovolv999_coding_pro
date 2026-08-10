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

import type { AgentModule, ModuleBootContext, ModuleBootResult } from '../core/module.js'
import type { Tool, ToolContext } from '../core/types.js'
import { McpStdioClient, type McpServerConfig, type McpResourceInfo, type McpResourceContent, type McpPromptInfo } from '../core/mcpClient.js'
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

    const tools: Tool[] = []
    for (const server of servers) {
      try {
        const client = this.createClient(server)
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

  private createClient(server: McpServerConfig): McpClient {
    if (server.type === 'http') {
      return new McpHttpClient(server)
    }
    return new McpStdioClient(server)
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
