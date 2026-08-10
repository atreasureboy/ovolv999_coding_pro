/**
 * SymbolIndexTool — exposes the codebase symbol index to the agent.
 *
 * Lets the agent answer "where is X defined?" and "what references X?"
 * instantly without grepping. The index is built lazily on first use
 * and refreshed incrementally.
 */

import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../core/types.js'
import { SymbolIndex } from '../core/symbolIndex.js'

export interface SymbolIndexInput {
  /** Query: 'lookup:<name>' | 'search:<prefix>' | 'refs:<name>' | 'stats' | 'build' */
  action: string
}

export class SymbolIndexTool implements Tool {
  name = 'SymbolIndex'
  metadata = {
    readOnly: true,
    concurrencySafe: true,
    searchHint: 'symbol index lookup find where defined references search symbols',
  }

  private index: SymbolIndex | null = null

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'SymbolIndex',
      description: `Query the codebase symbol index for fast symbol lookup.

Actions:
- lookup:NAME — exact symbol lookup (functions, classes, interfaces, types, enums, imports)
- search:PREFIX — prefix search across symbol names
- refs:NAME — find references to a symbol across the codebase
- stats — index statistics (files indexed, symbols indexed)
- build — force rebuild the index (usually automatic on first use)

Read-only and fast — use this instead of Grep when you need to find
where a symbol is defined or what references it.`,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'Query: lookup:NAME | search:PREFIX | refs:NAME | stats | build' },
        },
        required: ['action'],
      },
    },
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const { action } = input as Partial<SymbolIndexInput>
    const cwd = (context as { cwd?: string }).cwd ?? process.cwd()

    if (!this.index) {
      this.index = new SymbolIndex(cwd)
    }

    const a = (action ?? '').trim()

    if (a === 'stats') {
      const s = this.index.stats()
      return { content: `SymbolIndex: ${s.files} files indexed, ${s.symbols} symbols (root: ${s.root})`, isError: false }
    }

    if (a === 'build' || a === '') {
      await this.index.build()
      const s = this.index.stats()
      return { content: `Index built: ${s.files} files, ${s.symbols} symbols`, isError: false }
    }

    if (a.startsWith('lookup:')) {
      const name = a.slice(7).trim()
      if (!name) return { content: 'Error: lookup requires a symbol name', isError: true }
      await this.index.build()
      this.index.refreshStale()
      const hits = this.index.lookup(name)
      if (hits.length === 0) return { content: `No symbol "${name}" found in index.`, isError: false }
      const lines = hits.map(h =>
        `${h.relativePath}:${h.line}:${h.column}  ${h.kind}${h.exported ? ' (exported)' : ''}  ${h.signature.slice(0, 90)}`,
      )
      return { content: `Symbol "${name}":\n${lines.join('\n')}`, isError: false }
    }

    if (a.startsWith('search:')) {
      const prefix = a.slice(7).trim()
      if (!prefix) return { content: 'Error: search requires a prefix', isError: true }
      await this.index.build()
      const hits = this.index.search(prefix)
      if (hits.length === 0) return { content: `No symbols start with "${prefix}".`, isError: false }
      const lines = hits.map(h => `${h.name}  ${h.kind}  ${h.relativePath}:${h.line}`)
      return { content: `Symbols matching "${prefix}":\n${lines.join('\n')}`, isError: false }
    }

    if (a.startsWith('refs:')) {
      const name = a.slice(5).trim()
      if (!name) return { content: 'Error: refs requires a symbol name', isError: true }
      await this.index.build()
      const hits = this.index.findReferences(name)
      if (hits.length === 0) return { content: `No references to "${name}" found.`, isError: false }
      const lines = hits.slice(0, 30).map(h => `${h.relativePath}:${h.line}:${h.column}  ${h.snippet}`)
      const more = hits.length > 30 ? `\n… and ${hits.length - 30} more` : ''
      return { content: `References to "${name}" (${hits.length}):\n${lines.join('\n')}${more}`, isError: false }
    }

    return { content: 'Error: unknown action. Use lookup:NAME | search:PREFIX | refs:NAME | stats | build', isError: true }
  }
}
