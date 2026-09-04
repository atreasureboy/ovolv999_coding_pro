/**
 * GrepTool — search file contents with regex
 * Reference: src/tools/GrepTool/
 * Engine chain: ripgrep (rg) → system grep → pure-JS scanner.
 * The JS engine guarantees the tool NEVER hard-fails on minimal boxes.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { relative, isAbsolute, join } from 'path'
import { readdirSync, readFileSync, statSync } from 'fs'
import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import type { ResourceClaim } from '../core/executionRun.js'
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
  /** Patterns to EXCLUDE (ripgrep --glob=!x semantics; matched against
   *  basenames in the JS engine). */
  exclude?: string[]
  /** Multiline matching (`rg -U`): let `^`/`$` and char classes span
   *  lines. Only meaningful with output_mode=content. */
  multiline?: boolean
  /** Stop after N matched LINES in content mode (replaces the blunt
   *  500-line output cap; when more matches exist a truncation notice
   *  with the true total is appended). */
  head_limit?: number
}

/** Glob → RegExp for the JS engine. Supports * / ** / ? and a trailing
 *  `*` prefix match when the pattern has no slash (ripgrep --glob
 *  semantics for basenames). */
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/(.*)/g, '(?:.*/)?$1')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}

/** Pure-JS content search — the engine of last resort (no rg, no grep).
 *  Walks the tree (bounded depth/count), skips binaries + common junk. */
function jsSearch(
  root: string,
  pattern: string,
  opts: {
    caseInsensitive: boolean
    includeGlob?: string
    excludeGlobs: string[]
    mode: 'files_with_matches' | 'content' | 'count'
    contextLines: number
    headLimit: number
  },
): { lines: string[]; truncated: boolean } {
  let re: RegExp
  try {
    re = new RegExp(pattern, opts.caseInsensitive ? 'i' : '')
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), opts.caseInsensitive ? 'i' : '')
  }
  const includeRe = opts.includeGlob
    ? globToRegExp(opts.includeGlob.includes('/') ? opts.includeGlob : `**/${opts.includeGlob}`)
    : null
  const excludeRes = opts.excludeGlobs.map((g) => globToRegExp(g.includes('/') ? g : `**/${g}`))
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'target', '__pycache__', '.venv'])

  const out: string[] = []
  let truncated = false
  let visited = 0
  const MAX_FILES = 20_000
  const MAX_BYTES = 2 * 1024 * 1024

  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > 16 || truncated) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      if (truncated) return
      const full = join(dir, ent.name)
      // Excludes match the bare name OR the path relative to the search
      // root — `vendor/**` carries a slash, so testing only `ent.name`
      // could never match it and the directory stayed in the results.
      const excluded = excludeRes.some((r) => r.test(ent.name) || r.test(rel ? `${rel}/${ent.name}` : ent.name))
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name) || excluded) continue
        walk(full, rel ? `${rel}/${ent.name}` : ent.name, depth + 1)
      } else if (ent.isFile()) {
        if (visited++ > MAX_FILES) { truncated = true; return }
        if (excluded) continue
        if (includeRe && !includeRe.test(full.split('/').pop() ?? '') && !includeRe.test(full)) continue
        let content: string
        try {
          const st = statSync(full)
          if (st.size > MAX_BYTES) continue
          content = readFileSync(full, 'utf8')
        } catch {
          continue
        }
        if (content.includes('\u0000')) continue // binary
        const lines = content.split('\n')
        let fileMatched = false
        let count = 0
        const contentOut: string[] = []
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            fileMatched = true
            count++
            if (opts.mode === 'content') {
              contentOut.push(`${full}:${i + 1}:${lines[i].slice(0, 500)}`)
              if (opts.contextLines > 0) {
                for (let c = Math.max(0, i - opts.contextLines); c <= Math.min(lines.length - 1, i + opts.contextLines); c++) {
                  if (c !== i) contentOut.push(`${full}-${c + 1}-${lines[c].slice(0, 500)}`)
                }
              }
            }
          }
        }
        if (!fileMatched) continue
        if (opts.mode === 'files_with_matches') {
          out.push(full)
        } else if (opts.mode === 'count') {
          out.push(`${full}:${count}`)
        } else {
          out.push(...contentOut)
        }
        if (out.length > opts.headLimit + 500) { truncated = true; return }
      }
    }
  }
  walk(root, '', 0)
  return { lines: out, truncated }
}

export class GrepTool implements Tool {
  name = 'Grep'
  metadata = {
    readOnly: true,
    concurrencySafe: true,
    // GAP-D: read claim on the search root so concurrent writes to
    // that directory tree serialize against us. When no path is
    // supplied we make no claim (effectively the whole cwd — too
    // coarse to be useful, and historically the scheduler falls
    // back to the tool's static concurrencySafe flag).
    claims: (input: Record<string, unknown>): ResourceClaim[] => {
      const p = input.path
      return typeof p === 'string' && p
        ? [{ type: 'directory', key: p, access: 'read' }]
        : []
    },
  }

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
          exclude: {
            type: 'array',
            items: { type: 'string' },
            description: 'Glob patterns to EXCLUDE (e.g. ["*.test.ts", "vendor/**"])',
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
          multiline: {
            type: 'boolean',
            description: 'Multiline mode: let ^/$ span line boundaries (content mode, rg only)',
          },
          head_limit: {
            type: 'number',
            description: 'Max matched lines to return in content mode (default 200; report shows true total)',
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
      exclude: excludePatterns,
      output_mode = 'files_with_matches',
      context: contextLines,
      case_insensitive,
      multiline,
      head_limit,
    } = input as Partial<GrepInput>

    // include shorthand: "ts" → glob "*.ts"
    const effectiveGlob = globPattern ?? (includePattern ? `*.${includePattern}` : undefined)
    const excludes = Array.isArray(excludePatterns)
      ? excludePatterns.filter((p): p is string => typeof p === 'string' && p.length > 0)
      : []
    const headLimit = typeof head_limit === 'number' && head_limit > 0
      ? Math.min(head_limit, 2000)
      : 200

    if (!pattern || typeof pattern !== 'string') {
      return { content: 'Error: pattern is required', isError: true }
    }

    const searchDir = searchPath ?? context.cwd

    // Build rg command (preferred — faster, respects .gitignore)
    const args: string[] = []

    if (case_insensitive) args.push('-i')
    if (multiline && output_mode === 'content') args.push('-U', '--multiline-dotall')

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
      // Use the long `--glob=<value>` form so a glob starting with `-`
      // is unambiguously the FLAG's argument, never another flag.
      // (ripgrep, like most GNU-style CLIs, accepts a separate
      // positional after a long flag; `--glob -file.ts` would be
      // parsed as "ignore `--glob`, then take `-file.ts` as a new
      // flag — which is exactly the misinterpretation we're guarding
      // against. The `=` form pins the value to its flag.)
      args.push(`--glob=${effectiveGlob}`)
    }
    // Negated globs — rg applies every --glob; a `!` prefix excludes.
    for (const ex of excludes) {
      args.push(`--glob=!${ex}`)
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
      // Engine chain: rg → grep → pure-JS
      let stdout = ''
      try {
        const result = await execFileAsync('rg', args, {
          cwd: context.cwd,
          maxBuffer: 10 * 1024 * 1024,
          timeout: 30_000,
        })
        stdout = result.stdout
      } catch (err: unknown) {
        const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string }
        // rg exits with code 1 when no matches — not an error
        if (e.code === 1 && !e.stderr) {
          return { content: `No matches found for pattern: ${pattern}. Try case_insensitive:true, broaden the regex, remove the glob filter, or use Glob to confirm the file exists.`, isError: false }
        }
        // rg unavailable or failed → system grep fallback (feature-limited:
        // no exclude/multiline support there)
        if (e.code !== 1) {
          const grepFlags = ['-r', case_insensitive ? '-i' : '', output_mode === 'files_with_matches' ? '-l' : '-n']
            .filter(Boolean)
          if (effectiveGlob) grepFlags.push('--include', effectiveGlob)
          for (const ex of excludes) {
            if (ex.includes('/')) {
              // GNU grep's --exclude matches BASENAMES only — a
              // slash-bearing glob like `vendor/**` can never match any
              // so the directory stayed in the results. Exclude
              // by directory with the glob's leading path segment.
              const seg = ex.replace(/^\*\*\//, '').split('/')[0]
              if (seg && seg !== '*') grepFlags.push('--exclude-dir', seg)
            } else {
              grepFlags.push('--exclude', ex.replace(/\*\*/g, '*'))
            }
          }
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
            if (ge.code === 'ENOENT') {
              // Engine of last resort: pure-JS scanner — the tool must
              // never hard-fail on a minimal box.
              const js = jsSearch(
                isAbsolute(searchDir) ? searchDir : join(context.cwd, searchDir),
                pattern,
                {
                  caseInsensitive: case_insensitive === true,
                  includeGlob: effectiveGlob,
                  excludeGlobs: excludes,
                  mode: output_mode,
                  contextLines: typeof contextLines === 'number' ? contextLines : 0,
                  headLimit,
                },
              )
              return this.formatJsResult(js, pattern, output_mode, headLimit, context.cwd)
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

      // Convert absolute paths to relative — saves tokens in large codebases
      // (e.g. /home/user/projects/myapp/src/foo.ts → src/foo.ts)
      const lines = result.split('\n')
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

      // head_limit replaces the blunt 500-line cap: cut early but report
      // the TRUE match total so the model knows what it's missing.
      if (relLines.length > headLimit) {
        const shown = relLines.slice(0, headLimit).join('\n')
        return {
          content: `${shown}\n\n[... truncated: ${relLines.length - headLimit} more lines. Use head_limit to page, narrow the pattern, or use output_mode="count".]`,
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

  private formatJsResult(
    js: { lines: string[]; truncated: boolean },
    pattern: string,
    mode: 'files_with_matches' | 'content' | 'count',
    headLimit: number,
    cwd: string,
  ): ToolResult {
    if (js.lines.length === 0) {
      return {
        content: `No matches found for pattern: ${pattern} (JS fallback engine). Try case_insensitive:true, broaden the regex, or remove the glob filter.`,
        isError: false,
      }
    }
    const rel = js.lines.map((line) => {
      return line.replace(/^([^\s:]+)[:-]/, (match, p1: string) => {
        if (p1.startsWith('/')) {
          const r = relative(cwd, p1)
          return r.startsWith('..') ? match : `${r}:`
        }
        return match
      })
    })
    if (rel.length > headLimit) {
      return {
        content: `${rel.slice(0, headLimit).join('\n')}\n\n[... truncated: ${rel.length - headLimit} more lines (JS fallback engine). Use head_limit to page or narrow the pattern.]`,
        isError: false,
      }
    }
    if (js.truncated) {
      return { content: rel.join('\n') + '\n\n[JS fallback scan stopped early — directory too large. Install ripgrep for full coverage.]', isError: false }
    }
    return { content: rel.join('\n'), isError: false }
  }
}
