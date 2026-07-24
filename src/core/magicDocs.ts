/**
 * MagicDocs — automatic memory and documentation extraction
 *
 * Scans the codebase for implicit knowledge (API contracts, architectural
 * decisions, data models, config schemas) and extracts structured
 * documentation into the agent's knowledge base. This is the "auto
 * memory extraction" feature: instead of the user manually writing
 * AGENTS.md / CLAUDE.md notes, MagicDocs discovers them from the code.
 *
 * Extraction patterns:
 *   - API routes (REST handlers, Express/Fastify/Koa patterns)
 *   - Data models (TypeScript interfaces/types, Zod schemas, Prisma models)
 *   - Config schemas (env vars, config files)
 *   - Architecture decisions (TODO/FIXME/HACK/DECISION comments)
 *   - Test patterns (describe/it blocks reveal feature areas)
 *   - Dependency graph (imports reveal module relationships)
 *
 * Output: structured markdown sections that can be appended to the
 * project's AGENTS.md or written to a separate knowledge file.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs'
import { join, relative, extname, basename, dirname } from 'path'
import { execSync } from 'child_process'

// ── Types ───────────────────────────────────────────────────────────────────

export type DocSectionType =
  | 'api' | 'models' | 'config' | 'decisions'
  | 'patterns' | 'dependencies' | 'tests' | 'overview'

export interface DocSection {
  type: DocSectionType
  title: string
  content: string
  sourceFiles: string[]
}

export interface MagicDocsResult {
  sections: DocSection[]
  fileCount: number
  lineCount: number
  durationMs: number
  warnings: string[]
}

export interface MagicDocsOptions {
  /** Root directory to scan */
  rootDir: string
  /** File globs to include (default: source files) */
  include?: string[]
  /** Max files to scan (performance) */
  maxFiles?: number
  /** Sections to extract (default: all) */
  sections?: DocSectionType[]
  /** Output path (default: <root>/.ovolv999/magic-docs.md) */
  outputPath?: string
}

// ── File Discovery ──────────────────────────────────────────────────────────

const DEFAULT_INCLUDE = [
  '**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx',
  '**/*.py', '**/*.go', '**/*.rs', '**/*.java',
  '**/*.json', '**/*.yaml', '**/*.yml', '**/*.toml',
]

const DEFAULT_EXCLUDE = [
  'node_modules', '.git', 'dist', 'build', '.next',
  'coverage', '__pycache__', '.cache', 'vendor',
]

export function discoverFiles(rootDir: string, include?: string[], maxFiles = 5000): string[] {
  const patterns = include ?? DEFAULT_INCLUDE
  const files: string[] = []
  try {
    for (const pattern of patterns) {
      try {
        const ext = pattern.replace('**/*.', '')
        const out = execSync(
          `find ${shellQuote(rootDir)} -type f -name '*.${ext}' 2>/dev/null | head -n ${maxFiles}`,
          { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] },
        )
        for (const line of out.trim().split('\n')) {
          if (line && !DEFAULT_EXCLUDE.some((exc) => line.includes(`/${exc}/`))) {
            files.push(line)
          }
        }
      } catch { /* find failed for this pattern */ }
    }
  } catch { /* fall back to empty */ }

  // Deduplicate + sort
  const unique = [...new Set(files)].sort()
  return unique.slice(0, maxFiles)
}

// ── Extractors ──────────────────────────────────────────────────────────────

interface FileContent {
  path: string
  content: string
  lines: number
}

function readFiles(rootDir: string, files: string[]): FileContent[] {
  const contents: FileContent[] = []
  for (const file of files) {
    try {
      const full = file.startsWith('/') ? file : join(rootDir, file)
      const content = readFileSync(full, 'utf8')
      contents.push({ path: relative(rootDir, full), content, lines: content.split('\n').length })
    } catch { /* skip unreadable */ }
  }
  return contents
}

// ── API Extractor ───────────────────────────────────────────────────────────

function extractApi(files: FileContent[]): DocSection {
  const routes: Array<{ method: string; path: string; file: string; line: number }> = []
  const patterns: Array<{ regex: RegExp; method: string }> = [
    { regex: /(?:app|router|server)\.(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s*\(\s*['"`]([^'"`]+)['"`]/gi, method: '$1' },
    { regex: /@(Get|Post|Put|Delete|Patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi, method: '$1' }, // NestJS decorators
    { regex: /route\s*\.\s*(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi, method: '$1' },
    { regex: /\.(get|post|put|delete|patch)\s*\(\s*['"`](\/[^'"`]*)['"`]/gi, method: '$1' },
  ]

  for (const file of files) {
    const lines = file.content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      for (const { regex } of patterns) {
        regex.lastIndex = 0
        const match = regex.exec(lines[i])
        if (match) {
          const method = match[1].toUpperCase()
          const path = match[2]
          routes.push({ method, path, file: file.path, line: i + 1 })
        }
      }
    }
  }

  if (routes.length === 0) {
    return { type: 'api', title: 'API Endpoints', content: 'No API routes detected.', sourceFiles: [] }
  }

  const lines = [`Found ${routes.length} API endpoint(s):`, '']
  const byMethod: Record<string, typeof routes> = {}
  for (const r of routes) {
    if (!byMethod[r.method]) byMethod[r.method] = []
    byMethod[r.method].push(r)
  }
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    const group = byMethod[method]
    if (!group) continue
    lines.push(`### ${method}`)
    for (const r of group.slice(0, 50)) {
      lines.push(`- \`${r.path}\` — ${r.file}:${r.line}`)
    }
    if (group.length > 50) lines.push(`- ... and ${group.length - 50} more`)
    lines.push('')
  }

  return {
    type: 'api',
    title: 'API Endpoints',
    content: lines.join('\n'),
    sourceFiles: [...new Set(routes.map((r) => r.file))],
  }
}

// ── Models Extractor ────────────────────────────────────────────────────────

function extractModels(files: FileContent[]): DocSection {
  const models: Array<{ name: string; type: string; file: string; line: number }> = []

  for (const file of files) {
    const lines = file.content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      // TypeScript interfaces and types
      const ifMatch = lines[i].match(/^export\s+interface\s+([A-Z]\w+)/)
      if (ifMatch) {
        models.push({ name: ifMatch[1], type: 'interface', file: file.path, line: i + 1 })
        continue
      }
      const typeMatch = lines[i].match(/^export\s+type\s+([A-Z]\w+)/)
      if (typeMatch) {
        models.push({ name: typeMatch[1], type: 'type', file: file.path, line: i + 1 })
        continue
      }
      // Prisma models
      const prismaMatch = lines[i].match(/^model\s+(\w+)\s*\{/)
      if (prismaMatch) {
        models.push({ name: prismaMatch[1], type: 'prisma-model', file: file.path, line: i + 1 })
        continue
      }
      // Zod schemas
      const zodMatch = lines[i].match(/(?:const|let)\s+(\w+Schema)\s*=/)
      if (zodMatch) {
        models.push({ name: zodMatch[1], type: 'zod-schema', file: file.path, line: i + 1 })
        continue
      }
      // Python dataclasses / Pydantic
      const pyMatch = lines[i].match(/^class\s+(\w+)\s*\((?:BaseModel|dataclass)/)
      if (pyMatch) {
        models.push({ name: pyMatch[1], type: 'pydantic', file: file.path, line: i + 1 })
      }
    }
  }

  if (models.length === 0) {
    return { type: 'models', title: 'Data Models', content: 'No data models detected.', sourceFiles: [] }
  }

  const lines = [`Found ${models.length} data model(s):`, '']
  const byType: Record<string, typeof models> = {}
  for (const m of models) {
    if (!byType[m.type]) byType[m.type] = []
    byType[m.type].push(m)
  }
  for (const [type, group] of Object.entries(byType)) {
    lines.push(`### ${type}`)
    for (const m of group.slice(0, 30)) {
      lines.push(`- \`${m.name}\` — ${m.file}:${m.line}`)
    }
    lines.push('')
  }

  return {
    type: 'models',
    title: 'Data Models',
    content: lines.join('\n'),
    sourceFiles: [...new Set(models.map((m) => m.file))],
  }
}

// ── Config Extractor ────────────────────────────────────────────────────────

function extractConfig(files: FileContent[]): DocSection {
  const configVars: Array<{ name: string; file: string; line: number; description?: string }> = []

  for (const file of files) {
    const lines = file.content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      // env vars: process.env.XXX
      const envMatches = [...lines[i].matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)]
      for (const m of envMatches) {
        configVars.push({ name: m[1], file: file.path, line: i + 1 })
      }
      // .env file lines
      if (extname(file.path) === '' && basename(file.path) === '.env') {
        const envLine = lines[i].match(/^([A-Z_][A-Z0-9_]*)=/)
        if (envLine) {
          configVars.push({ name: envLine[1], file: file.path, line: i + 1 })
        }
      }
    }
  }

  if (configVars.length === 0) {
    return { type: 'config', title: 'Configuration', content: 'No configuration variables detected.', sourceFiles: [] }
  }

  const unique = [...new Map(configVars.map((v) => [v.name, v])).values()].sort((a, b) => a.name.localeCompare(b.name))
  const lines = [`Found ${unique.length} configuration variable(s):`, '']
  for (const v of unique.slice(0, 50)) {
    lines.push(`- \`${v.name}\` — ${v.file}:${v.line}`)
  }
  if (unique.length > 50) lines.push(`- ... and ${unique.length - 50} more`)

  return {
    type: 'config',
    title: 'Configuration',
    content: lines.join('\n'),
    sourceFiles: [...new Set(configVars.map((v) => v.file))],
  }
}

// ── Decisions Extractor ─────────────────────────────────────────────────────

function extractDecisions(files: FileContent[]): DocSection {
  const decisions: Array<{ tag: string; text: string; file: string; line: number }> = []

  for (const file of files) {
    const lines = file.content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/\b(TODO|FIXME|HACK|DECISION|NOTE|WARN|XXX|BUG)\b:?\s*(.*)/)
      if (match) {
        decisions.push({
          tag: match[1],
          text: match[2].trim().slice(0, 120),
          file: file.path,
          line: i + 1,
        })
      }
    }
  }

  if (decisions.length === 0) {
    return { type: 'decisions', title: 'Decisions & TODOs', content: 'No decision markers found.', sourceFiles: [] }
  }

  const lines = [`Found ${decisions.length} marker(s):`, '']
  const byTag: Record<string, typeof decisions> = {}
  for (const d of decisions) {
    if (!byTag[d.tag]) byTag[d.tag] = []
    byTag[d.tag].push(d)
  }
  for (const [tag, group] of Object.entries(byTag)) {
    lines.push(`### ${tag} (${group.length})`)
    for (const d of group.slice(0, 20)) {
      lines.push(`- ${d.text || '(no text)'} — ${d.file}:${d.line}`)
    }
    if (group.length > 20) lines.push(`- ... and ${group.length - 20} more`)
    lines.push('')
  }

  return {
    type: 'decisions',
    title: 'Decisions & TODOs',
    content: lines.join('\n'),
    sourceFiles: [...new Set(decisions.map((d) => d.file))],
  }
}

// ── Patterns Extractor ──────────────────────────────────────────────────────

function extractPatterns(files: FileContent[]): DocSection {
  const patterns: Array<{ name: string; description: string; file: string }> = []

  for (const file of files) {
    // Class definitions
    const classMatches = [...file.content.matchAll(/export\s+class\s+(\w+)/g)]
    for (const m of classMatches) {
      patterns.push({ name: m[1], description: 'class', file: file.path })
    }
    // Function exports
    const fnMatches = [...file.content.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)]
    for (const m of fnMatches) {
      patterns.push({ name: m[1], description: 'function', file: file.path })
    }
    // React components
    const compMatches = [...file.content.matchAll(/export\s+(?:default\s+)?function\s+([A-Z]\w*)\s*\(/g)]
    for (const m of compMatches) {
      patterns.push({ name: m[1], description: 'component', file: file.path })
    }
  }

  if (patterns.length === 0) {
    return { type: 'patterns', title: 'Code Patterns', content: 'No notable patterns detected.', sourceFiles: [] }
  }

  const byDesc: Record<string, typeof patterns> = {}
  for (const p of patterns) {
    if (!byDesc[p.description]) byDesc[p.description] = []
    byDesc[p.description].push(p)
  }

  const lines = [`Detected ${patterns.length} exported constructs:`, '']
  for (const [desc, group] of Object.entries(byDesc)) {
    lines.push(`### ${desc}s (${group.length})`)
    const names = [...new Set(group.map((p) => p.name))].sort().slice(0, 30)
    lines.push(names.map((n) => `- \`${n}\``).join('\n'))
    lines.push('')
  }

  return {
    type: 'patterns',
    title: 'Code Patterns',
    content: lines.join('\n'),
    sourceFiles: [...new Set(patterns.map((p) => p.file))],
  }
}

// ── Dependencies Extractor ──────────────────────────────────────────────────

function extractDependencies(files: FileContent[], _rootDir: string): DocSection {
  const importMap: Record<string, Set<string>> = {}

  for (const file of files) {
    // ESM imports
    const importMatches = [...file.content.matchAll(/import\s+.*?\s+from\s+['"]([^'"]+)['"]/g)]
    for (const m of importMatches) {
      const dep = m[1]
      if (!dep.startsWith('.') && !dep.startsWith('/')) {
        if (!importMap[dep]) importMap[dep] = new Set()
        importMap[dep].add(file.path)
      }
    }
    // CommonJS requires
    const requireMatches = [...file.content.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)]
    for (const m of requireMatches) {
      const dep = m[1]
      if (!dep.startsWith('.') && !dep.startsWith('/')) {
        if (!importMap[dep]) importMap[dep] = new Set()
        importMap[dep].add(file.path)
      }
    }
  }

  const deps = Object.entries(importMap)
    .map(([dep, files]) => ({ dep, count: files.size }))
    .sort((a, b) => b.count - a.count)

  if (deps.length === 0) {
    return { type: 'dependencies', title: 'Dependencies', content: 'No external dependencies detected.', sourceFiles: [] }
  }

  const lines = [`External dependencies (${deps.length}):`, '']
  for (const d of deps.slice(0, 30)) {
    lines.push(`- \`${d.dep}\` (used in ${d.count} file${d.count > 1 ? 's' : ''})`)
  }
  if (deps.length > 30) lines.push(`- ... and ${deps.length - 30} more`)

  return {
    type: 'dependencies',
    title: 'Dependencies',
    content: lines.join('\n'),
    sourceFiles: [],
  }
}

// ── Overview Extractor ──────────────────────────────────────────────────────

function extractOverview(files: FileContent[], rootDir: string): DocSection {
  const byExt: Record<string, number> = {}
  for (const f of files) {
    const ext = extname(f.path) || '(no ext)'
    byExt[ext] = (byExt[ext] ?? 0) + 1
  }

  const totalLines = files.reduce((sum, f) => sum + f.lines, 0)
  const lines = [
    `Project overview:`,
    `  Root: ${rootDir}`,
    `  Files scanned: ${files.length}`,
    `  Total lines: ${totalLines.toLocaleString()}`,
    `  Languages:`,
  ]
  const sorted = Object.entries(byExt).sort(([, a], [, b]) => b - a)
  for (const [ext, count] of sorted.slice(0, 10)) {
    lines.push(`    ${ext}: ${count} file${count > 1 ? 's' : ''}`)
  }

  return {
    type: 'overview',
    title: 'Project Overview',
    content: lines.join('\n'),
    sourceFiles: [],
  }
}

// ── Main Extraction ─────────────────────────────────────────────────────────

export function extractDocs(options: MagicDocsOptions): MagicDocsResult {
  const start = Date.now()
  const warnings: string[] = []

  if (!existsSync(options.rootDir)) {
    return {
      sections: [],
      fileCount: 0,
      lineCount: 0,
      durationMs: Date.now() - start,
      warnings: [`Root directory does not exist: ${options.rootDir}`],
    }
  }

  // Discover files
  const files = discoverFiles(options.rootDir, options.include, options.maxFiles ?? 5000)
  if (files.length === 0) {
    warnings.push('No files discovered — check include patterns')
  }

  // Read contents
  const contents = readFiles(options.rootDir, files)
  const totalLines = contents.reduce((sum, f) => sum + f.lines, 0)

  // Extract sections
  const wantedSections = options.sections ?? ['overview', 'api', 'models', 'config', 'decisions', 'patterns', 'dependencies']
  const sections: DocSection[] = []

  for (const sectionType of wantedSections) {
    try {
      switch (sectionType) {
        case 'overview': sections.push(extractOverview(contents, options.rootDir)); break
        case 'api': sections.push(extractApi(contents)); break
        case 'models': sections.push(extractModels(contents)); break
        case 'config': sections.push(extractConfig(contents)); break
        case 'decisions': sections.push(extractDecisions(contents)); break
        case 'patterns': sections.push(extractPatterns(contents)); break
        case 'dependencies': sections.push(extractDependencies(contents, options.rootDir)); break
      }
    } catch (err) {
      warnings.push(`Failed to extract ${sectionType}: ${(err as Error).message}`)
    }
  }

  // Write output
  if (options.outputPath) {
    const dir = dirname(options.outputPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(options.outputPath, formatResult({ sections, fileCount: files.length, lineCount: totalLines, durationMs: 0, warnings }))
  }

  return {
    sections,
    fileCount: files.length,
    lineCount: totalLines,
    durationMs: Date.now() - start,
    warnings,
  }
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatResult(result: MagicDocsResult): string {
  const lines = [
    '# MagicDocs — Auto-Extracted Project Knowledge',
    '',
    `> Generated from ${result.fileCount} files (${result.lineCount.toLocaleString()} lines) in ${result.durationMs}ms`,
    '',
  ]

  for (const section of result.sections) {
    lines.push(`## ${section.title}`, '')
    lines.push(section.content)
    lines.push('')
  }

  if (result.warnings.length > 0) {
    lines.push('## Warnings', '')
    for (const w of result.warnings) lines.push(`- ${w}`)
    lines.push('')
  }

  return lines.join('\n')
}

export function formatSection(section: DocSection): string {
  return `### ${section.title}\n${section.content}`
}

function shellQuote(s: string): string {
  if (s === '') return "''"
  if (/^[A-Za-z0-9_:.@/=-]+$/.test(s)) return s
  return `'${s.replace(/'/g, "'\\''")}'`
}
