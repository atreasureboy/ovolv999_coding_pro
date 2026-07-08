/**
 * GrepTool — search file contents with regex
 * Reference: src/tools/GrepTool/
 * Uses ripgrep (rg) if available, falls back to Node.js regex scan
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { relative } from 'path'
import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import { GREP_DESCRIPTION } from '../prompts/tools.js'

const execFileAsync = promisify(execFile)

export interface GrepInput {
  pattern: string
  path?: string
  glob?: string
  output_mode?: 'files_with_matches' | 'content' | 'count'
  context?: number
  case_insensitive?: boolean
  include?: string
}

export class GrepTool implements Tool {
  name = 'Grep'

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'Grep',
      description: GREP_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Regex pattern to search for',
          },
          path: {
            type: 'string',
            description: 'File or directory to search (defaults to cwd)',
          },
          glob: {
            type: 'string',
            description: 'File pattern filter (e.g. "*.ts", "**/*.tsx")',
          },
          include: {
            type: 'string',
            description: 'File extension filter (e.g. "ts", "js", "py"). Shorthand for glob: "*.ts"',
          },
          output_mode: {
            type: 'string',
            enum: ['files_with_matches', 'content', 'count'],
            description: 'Output mode (default: files_with_matches)',
          },
          context: {
            type: 'number',
            description: 'Lines of context around matches (for content mode)',
          },
          case_insensitive: {
            type: 'boolean',
            description: 'Case-insensitive search',
          },
        },
        required: ['pattern'],
      },
    },
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const {
      pattern,
      path: searchPath,
      glob: globPattern,
      include: includePattern,
      output_mode = 'files_with_matches',
      context: contextLines,
      case_insensitive,
    } = input as unknown as GrepInput

    // include shorthand: "ts" → glob "*.ts"
    const effectiveGlob = globPattern ?? (includePattern ? `*.${includePattern}` : undefined)

    if (!pattern || typeof pattern !== 'string') {
      return { content: 'Error: pattern is required', isError: true }
    }

    const searchDir = searchPath ?? context.cwd

    // Build rg command (preferred — faster, respects .gitignore)
    const args: string[] = []

    if (case_insensitive) args.push('-i')

    switch (output_mode) {
      case 'files_with_matches':
        args.push('-l')
        break
      case 'count':
        args.push('-c')
        break
      case 'content':
        args.push('-n') // line numbers
        if (typeof contextLines === 'number' && contextLines > 0) {
          args.push(`-C${contextLines}`)
        }
        break
    }

    if (effectiveGlob) {
      args.push(`--glob`, `${effectiveGlob}`)
    }

    // Truncate long lines to prevent context pollution from minified/base64 content
    args.push('--max-columns', '500')

    // Use -e flag for patterns starting with '-' (prevents rg from interpreting as flag)
    if (pattern.startsWith('-')) {
      args.push('-e', pattern)
    } else {
      args.push(pattern)
    }
    args.push(searchDir)

    try {
      // Use execFile to avoid shell quoting issues on Windows
      // Try rg first, fall back to grep via exec if rg not found
      let stdout: string
      try {
        const result = await execFileAsync('rg', args, {
          cwd: context.cwd,
          maxBuffer: 10 * 1024 * 1024,
          timeout: 30_000,
        })
        stdout = result.stdout
      } catch (err: unknown) {
        const e = err as { code?: number; stdout?: string; stderr?: string; message?: string }
        // rg exits with code 1 when no matches — not an error
        if (e.code === 1 && !e.stderr) {
          return { content: `No matches found for pattern: ${pattern}. Try case_insensitive:true, broaden the regex, remove the glob filter, or use Glob to confirm the file exists.`, isError: false }
        }
        // rg not found (ENOENT) or other error — fall back to Node.js search
        stdout = ''
        // If rg failed for non-"no matches" reasons, try grep as fallback
        if (e.code !== 1) {
          // Build grep fallback command
          const grepFlags = ['-r', case_insensitive ? '-i' : '', output_mode === 'files_with_matches' ? '-l' : '-n']
            .filter(Boolean)
          if (effectiveGlob) grepFlags.push('--include', effectiveGlob)
          grepFlags.push('-E', pattern, searchDir)
          try {
            const fallback = await execFileAsync('grep', grepFlags.filter(Boolean), {
              cwd: context.cwd,
              maxBuffer: 10 * 1024 * 1024,
              timeout: 30_000,
            })
            stdout = fallback.stdout
          } catch (grepErr) {
            const ge = grepErr as { code?: string | number }
            // Distinguish "grep not installed" from "no matches"
            if (ge.code === 'ENOENT') {
              return { content: `Error: neither ripgrep (rg) nor grep is available on this system. Install ripgrep for best results.`, isError: true }
            }
            // grep ran but exited non-zero (no matches or error) — treat as no matches
            return { content: `No matches found for pattern: ${pattern}. Try case_insensitive:true, broaden the regex, remove the glob filter, or use Glob to confirm the file exists.`, isError: false }
          }
        }
      }

      const result = stdout.trim()
      if (!result) {
        return { content: `No matches found for pattern: ${pattern}. Try case_insensitive:true, broaden the regex, remove the glob filter, or use Glob to confirm the file exists.`, isError: false }
      }

      // Cap output to avoid flooding context
      const lines = result.split('\n')
      // Convert absolute paths to relative — saves tokens in large codebases
      // (e.g. /home/user/projects/myapp/src/foo.ts → src/foo.ts)
      const relLines = lines.map((line) => {
        try {
          return line.replace(/^([^\s:]+):/, (match, p1: string) => {
            if (p1.startsWith('/')) {
              const rel = relative(context.cwd, p1)
              return rel.startsWith('..') ? match : `${rel}:`
            }
            return match
          })
        } catch {
          return line
        }
      })

      if (relLines.length > 500) {
        const truncated = relLines.slice(0, 500).join('\n')
        return {
          content: `${truncated}\n\n[... truncated: ${relLines.length - 500} more lines. Narrow your pattern or use output_mode="count" to reduce results.]`,
          isError: false,
        }
      }

      return { content: relLines.join('\n'), isError: false }
    } catch (err: unknown) {
      // rg exits with code 1 when no matches — that's not an error
      const error = err as { code?: number; stdout?: string; stderr?: string }
      if (error.code === 1 && !error.stderr) {
        return { content: `No matches found for pattern: ${pattern}. Try case_insensitive:true, broaden the regex, remove the glob filter, or use Glob to confirm the file exists.`, isError: false }
      }
      const msg = error.stderr ?? (err as Error).message ?? 'Unknown grep error'
      return { content: `Grep error: ${msg}`, isError: true }
    }
  }
}
