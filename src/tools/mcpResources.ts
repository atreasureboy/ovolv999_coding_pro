/**
 * MCP Resource Tools
 *
 * Expose MCP server resources and prompts to the LLM.
 *   ListMcpResources — list resources/prompts from connected MCP servers
 *   ReadMcpResource  — read a specific resource by URI
 */

import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'

type McpRegistryEntry = NonNullable<ToolContext['mcpRegistry']> extends Map<string, infer E> ? E : never

function getRegistry(ctx: ToolContext): Map<string, McpRegistryEntry> | undefined {
  return ctx.mcpRegistry
}

// ── ListMcpResources ────────────────────────────────────────────────────────

export class ListMcpResourcesTool implements Tool {
  name = 'ListMcpResources'
  metadata = { readOnly: true, concurrencySafe: true }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'ListMcpResources',
      description: `List resources and prompts exposed by connected MCP (Model Context Protocol) servers.

## When to Use
- Discover what data/files/context MCP servers can provide
- Find available prompt templates from MCP servers
- Explore MCP server capabilities before reading a specific resource

## Output
Lists resources (with URIs, names, descriptions) and prompts from each connected server.`,
      parameters: {
        type: 'object',
        properties: {
          server: {
            type: 'string',
            description: 'Filter to a specific MCP server name. Omit to list from all servers.',
          },
        },
      },
    },
  }

  isConcurrencySafe(): boolean {
    return true
  }

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const registry = getRegistry(ctx)
    if (!registry || registry.size === 0) {
      return { content: 'No MCP servers connected.', isError: false }
    }

    const filterServer = input.server as string | undefined
    const lines: string[] = []

    for (const [name, entry] of registry) {
      if (filterServer && name !== filterServer) continue
      try {
        const [resources, prompts] = await Promise.all([
          entry.client.listResources().catch(() => []),
          entry.client.listPrompts().catch(() => []),
        ])

        lines.push(`\n=== ${name} ===`)

        if (resources.length > 0) {
          lines.push(`Resources (${resources.length}):`)
          for (const r of resources) {
            const desc = r.description ? ` — ${r.description}` : ''
            const mime = r.mimeType ? ` [${r.mimeType}]` : ''
            lines.push(`  ${r.uri}${mime}${desc}`)
          }
        } else {
          lines.push('Resources: none')
        }

        if (prompts.length > 0) {
          lines.push(`Prompts (${prompts.length}):`)
          for (const p of prompts) {
            const desc = p.description ? ` — ${p.description}` : ''
            const args = p.arguments?.map(a => `${a.name}${a.required ? '!' : ''}`).join(', ')
            lines.push(`  /${p.name}${args ? ` (${args})` : ''}${desc}`)
          }
        }
      } catch (err) {
        lines.push(`\n=== ${name} === (error: ${err instanceof Error ? err.message : String(err)})`)
      }
    }

    if (lines.length === 0) {
      return { content: filterServer ? `No MCP server named "${filterServer}".` : 'No MCP servers connected.', isError: false }
    }

    return { content: lines.join('\n'), isError: false }
  }
}

// ── ReadMcpResource ─────────────────────────────────────────────────────────

export class ReadMcpResourceTool implements Tool {
  name = 'ReadMcpResource'
  metadata = { readOnly: true, concurrencySafe: true }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'ReadMcpResource',
      description: `Read a specific resource from a connected MCP server by its URI.

## When to Use
- Read a file/data source exposed by an MCP server
- Retrieve context that an MCP server provides (e.g., database schema, API docs)
- After using ListMcpResources to find the URI

## Parameters
- uri: The resource URI (from ListMcpResources)
- server: Optional server name (required if multiple servers expose the same URI)`,
      parameters: {
        type: 'object',
        properties: {
          uri: { type: 'string', description: 'The resource URI to read' },
          server: { type: 'string', description: 'Specific MCP server name (optional)' },
        },
        required: ['uri'],
      },
    },
  }

  isConcurrencySafe(): boolean {
    return true
  }

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const registry = getRegistry(ctx)
    if (!registry || registry.size === 0) {
      return { content: 'No MCP servers connected.', isError: true }
    }

    const uri = input.uri as string
    if (!uri) {
      return { content: 'Error: uri is required', isError: true }
    }

    const serverName = input.server as string | undefined

    // Find the server that has this resource
    let targetEntry: McpRegistryEntry | undefined
    if (serverName) {
      targetEntry = registry.get(serverName)
      if (!targetEntry) {
        return { content: `No MCP server named "${serverName}".`, isError: true }
      }
    } else {
      // Search all servers for the URI
      for (const [, entry] of registry) {
        try {
          const resources = await entry.client.listResources()
          if (resources.some(r => r.uri === uri)) {
            targetEntry = entry
            break
          }
        } catch { /* try next */ }
      }
      if (!targetEntry) {
        // Fallback: try reading from the first server
        targetEntry = registry.values().next().value
      }
    }

    try {
      const contents = await targetEntry!.client.readResource(uri)
      if (contents.length === 0) {
        return { content: `Resource "${uri}" returned no content.`, isError: false }
      }

      const parts: string[] = []
      for (const c of contents) {
        const mime = c.mimeType ? ` [${c.mimeType}]` : ''
        if (c.text !== undefined) {
          parts.push(`=== ${c.uri}${mime} ===\n${c.text}`)
        } else if (c.blob !== undefined) {
          parts.push(`=== ${c.uri}${mime} ===\n[binary content: ${c.blob.length} bytes base64]`)
        }
      }

      return { content: parts.join('\n\n'), isError: false }
    } catch (err) {
      return {
        content: `Failed to read resource "${uri}": ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }
  }
}
