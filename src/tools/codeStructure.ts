/**
 * CodeStructureTool — AST-aware code analysis tool (v0.6.0).
 *
 * Inspired by Codex's tree-sitter integration: provides structural
 * code analysis without a language server. Exposes the codeStructure
 * module as a tool the agent can call.
 *
 * Operations:
 *   - analyze <file> — extract symbols, imports, TODOs from a file
 *   - scan <dir> — scan a codebase for symbols and structure
 *   - refs <symbol> — find all references to a symbol
 *   - diff <file> — semantic diff between old and new content
 */

import { existsSync, readFileSync } from 'fs'
import {
  analyzeFile,
  scanCodebase,
  findReferences,
  semanticDiff,
  type CodeStructure,
  type CodebaseScan,
  type DiffSymbol,
} from '../core/codeStructure.js'
import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'

export type CodeStructureAction = 'analyze' | 'scan' | 'refs' | 'diff'

export interface CodeStructureInput {
  action: CodeStructureAction
  file?: string
  dir?: string
  symbol?: string
  old_content?: string
  new_content?: string
}

export class CodeStructureTool implements Tool {
  name = 'CodeStructure'
  metadata = {
    mutatesState: false,
    concurrencySafe: true,
  }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'CodeStructure',
      description:
        'Analyze code structure: extract symbols (functions, classes, interfaces), ' +
        'imports, TODOs, and find references across the codebase. ' +
        'Use this to understand how code is organized before making changes. ' +
        'Actions: analyze (single file), scan (directory), refs (find symbol references), ' +
        'diff (semantic diff between two versions).',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['analyze', 'scan', 'refs', 'diff'],
            description: 'What to do: analyze a file, scan a directory, find references, or diff',
          },
          file: {
            type: 'string',
            description: 'File path (for analyze, diff actions)',
          },
          dir: {
            type: 'string',
            description: 'Directory path (for scan, refs actions)',
          },
          symbol: {
            type: 'string',
            description: 'Symbol name to find references for (for refs action)',
          },
          old_content: {
            type: 'string',
            description: 'Old file content (for diff action)',
          },
          new_content: {
            type: 'string',
            description: 'New file content (for diff action)',
          },
        },
        required: ['action'],
      },
    },
  }

  async execute(
    input: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolResult> {
    const { action, file, dir, symbol, old_content, new_content } =
      input as Partial<CodeStructureInput>

    try {
      switch (action) {
        case 'analyze': {
          if (!file) return { content: 'Error: file path is required for analyze', isError: true }
          if (!existsSync(file)) return { content: `Error: file not found: ${file}`, isError: true }
          const structure = analyzeFile(file)
          return { content: this.formatStructure(structure), isError: false }
        }

        case 'scan': {
          const root = dir ?? process.cwd()
          if (!existsSync(root)) return { content: `Error: directory not found: ${root}`, isError: true }
          const scan = scanCodebase(root)
          return { content: this.formatScan(scan), isError: false }
        }

        case 'refs': {
          if (!symbol) return { content: 'Error: symbol name is required for refs', isError: true }
          const root = dir ?? process.cwd()
          const refs = findReferences(symbol, root)
          return { content: this.formatReferences(symbol, refs), isError: false }
        }

        case 'diff': {
          if (!file) return { content: 'Error: file path is required for diff', isError: true }
          const oldSrc = old_content ?? (existsSync(file) ? readFileSync(file, 'utf8') : '')
          const newSrc = new_content ?? ''
          const diffs = semanticDiff(oldSrc, newSrc, file)
          return { content: this.formatDiff(diffs), isError: false }
        }

        default:
          return { content: `Error: unknown action "${action ?? '(none)'}". Use: analyze, scan, refs, diff`, isError: true }
      }
    } catch (err) {
      return { content: `CodeStructure error: ${(err as Error).message}`, isError: true }
    }
  }

  // ── Formatters ──────────────────────────────────────────────────────────

  private formatStructure(s: CodeStructure): string {
    const lines: string[] = []
    lines.push(`# Code Structure: ${s.file}`)
    lines.push(`Language: ${s.language} | Lines: ${s.lineCount} | Symbols: ${s.symbols.length} | Imports: ${s.imports.length}`)
    lines.push('')

    if (s.symbols.length > 0) {
      lines.push('## Symbols')
      const byKind: Record<string, CodeStructure['symbols']> = {}
      for (const sym of s.symbols) {
        (byKind[sym.kind] ??= []).push(sym)
      }
      for (const [kind, syms] of Object.entries(byKind)) {
        lines.push(`\n### ${kind}s (${syms.length})`)
        for (const sym of syms) {
          const exp = sym.exported ? ' [exported]' : ''
          const def = sym.isDefault ? ' [default]' : ''
          lines.push(`  L${sym.line}: ${sym.name}${exp}${def}`)
          if (sym.signature.length < 100) {
            lines.push(`    ${sym.signature.trim()}`)
          }
        }
      }
      lines.push('')
    }

    if (s.imports.length > 0) {
      lines.push('## Imports')
      for (const imp of s.imports) {
        const syms = imp.symbols.length > 0 ? ` (${imp.symbols.join(', ')})` : ''
        lines.push(`  L${imp.line}: from "${imp.source}"${syms}`)
      }
      lines.push('')
    }

    if (s.todos.length > 0) {
      lines.push('## TODOs / Markers')
      for (const todo of s.todos) {
        lines.push(`  ${todo}`)
      }
      lines.push('')
    }

    return lines.join('\n')
  }

  private formatScan(scan: CodebaseScan): string {
    const lines: string[] = []
    lines.push(`# Codebase Scan: ${scan.root}`)
    lines.push(`Files: ${scan.files} | Total lines: ${scan.totalLines} | Symbols: ${scan.symbols.length}`)
    lines.push('')

    if (Object.keys(scan.languages).length > 0) {
      lines.push('## Languages')
      for (const [lang, count] of Object.entries(scan.languages).sort((a, b) => b[1] - a[1])) {
        lines.push(`  ${lang}: ${count} files`)
      }
      lines.push('')
    }

    if (scan.symbols.length > 0) {
      lines.push('## Top Symbols (by file count)')
      const byName = new Map<string, number>()
      for (const sym of scan.symbols) {
        byName.set(sym.name, (byName.get(sym.name) ?? 0) + 1)
      }
      const top = [...byName.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
      for (const [name, count] of top) {
        lines.push(`  ${name}: ${count} ${count === 1 ? 'file' : 'files'}`)
      }
      lines.push('')
    }

    if (scan.todos.length > 0) {
      lines.push(`## TODOs / Markers (${scan.todos.length})`)
      const preview = scan.todos.slice(0, 30)
      for (const todo of preview) {
        lines.push(`  ${todo}`)
      }
      if (scan.todos.length > 30) {
        lines.push(`  ... and ${scan.todos.length - 30} more`)
      }
      lines.push('')
    }

    return lines.join('\n')
  }

  private formatReferences(
    symbol: string,
    refs: Array<{ file: string; line: number; context: string }>,
  ): string {
    if (refs.length === 0) {
      return `No references found for "${symbol}".`
    }

    const lines: string[] = []
    lines.push(`# References to "${symbol}" (${refs.length} found)`)
    lines.push('')

    const byFile = new Map<string, typeof refs>()
    for (const ref of refs) {
      const list = byFile.get(ref.file) ?? []
      list.push(ref)
      byFile.set(ref.file, list)
    }

    for (const [file, fileRefs] of byFile) {
      lines.push(`## ${file} (${fileRefs.length})`)
      for (const ref of fileRefs.slice(0, 10)) {
        lines.push(`  L${ref.line}: ${ref.context}`)
      }
      if (fileRefs.length > 10) {
        lines.push(`  ... and ${fileRefs.length - 10} more`)
      }
      lines.push('')
    }

    return lines.join('\n')
  }

  private formatDiff(diffs: DiffSymbol[]): string {
    if (diffs.length === 0) {
      return 'No structural changes detected.'
    }

    const lines: string[] = []
    lines.push(`# Semantic Diff: ${diffs.length} structural changes`)
    lines.push('')

    const added = diffs.filter((d) => d.kind === 'added')
    const removed = diffs.filter((d) => d.kind === 'removed')
    const modified = diffs.filter((d) => d.kind === 'modified')

    if (added.length > 0) {
      lines.push(`## Added (${added.length})`)
      for (const d of added) {
        lines.push(`  + ${d.symbol} in ${d.file}`)
      }
      lines.push('')
    }

    if (removed.length > 0) {
      lines.push(`## Removed (${removed.length})`)
      for (const d of removed) {
        lines.push(`  - ${d.symbol} in ${d.file}`)
      }
      lines.push('')
    }

    if (modified.length > 0) {
      lines.push(`## Modified (${modified.length})`)
      for (const d of modified) {
        lines.push(`  ~ ${d.symbol} in ${d.file}`)
        if (d.oldSignature) lines.push(`    old: ${d.oldSignature.trim()}`)
        if (d.newSignature) lines.push(`    new: ${d.newSignature.trim()}`)
      }
      lines.push('')
    }

    return lines.join('\n')
  }
}