/**
 * System Prompt Builder
 *
 * Builds rich system prompts with project context, git status,
 * memory files (CLAUDE.md), and mode-specific prompts.
 */

import { existsSync, readFileSync, readdirSync } from 'fs'
import { join, resolve, basename } from 'path'
import { execSync } from 'child_process'

// ── Types ───────────────────────────────────────────────────────────────────

export interface SystemPromptOptions {
  cwd: string
  modePrompt?: string
  taskContext?: string
  customInstructions?: string
  includeGitStatus?: boolean
  includeProjectTree?: boolean
  maxTreeDepth?: number
}

export interface GitStatusInfo {
  branch: string | null
  isClean: boolean
  staged: string[]
  modified: string[]
  untracked: string[]
  recentCommits: Array<{ hash: string; message: string }>
  userName: string | null
}

// ── Git Status ──────────────────────────────────────────────────────────────

export function getGitStatusInfo(cwd: string): GitStatusInfo {
  const info: GitStatusInfo = {
    branch: null,
    isClean: true,
    staged: [],
    modified: [],
    untracked: [],
    recentCommits: [],
    userName: null,
  }

  try {
    info.branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'],
    }).trim()

    info.userName = execSync('git config user.name', {
      cwd, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'],
    }).trim() || null

    const status = execSync('git status --short', {
      cwd, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'],
    }).trim()

    if (status) {
      info.isClean = false
      for (const line of status.split('\n')) {
        if (!line.trim()) continue
        const flag = line.slice(0, 2)
        const file = line.slice(3)
        if (flag.includes('?')) info.untracked.push(file)
        else if (flag.match(/[MARC]/)) info.staged.push(file)
        if (flag.match(/[marc]/)) info.modified.push(file)
      }
    }

    const log = execSync('git log --oneline -5', {
      cwd, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'],
    }).trim()

    if (log) {
      info.recentCommits = log.split('\n').map(line => {
        const [hash, ...msgParts] = line.split(' ')
        return { hash, message: msgParts.join(' ') }
      })
    }
  } catch {
    // Not a git repo or git not available
  }

  return info
}

export function formatGitStatus(info: GitStatusInfo): string {
  if (!info.branch) return ''
  const lines: string[] = []
  lines.push(`Git branch: ${info.branch}`)
  if (info.userName) lines.push(`Git user: ${info.userName}`)
  if (info.isClean) {
    lines.push('Working tree: clean')
  } else {
    if (info.staged.length > 0) {
      lines.push(`Staged: ${info.staged.length} file(s)`)
    }
    if (info.modified.length > 0) {
      lines.push(`Modified: ${info.modified.length} file(s)`)
    }
    if (info.untracked.length > 0) {
      lines.push(`Untracked: ${info.untracked.length} file(s)`)
    }
  }
  if (info.recentCommits.length > 0) {
    lines.push('Recent commits:')
    for (const c of info.recentCommits.slice(0, 3)) {
      lines.push(`  ${c.hash} ${c.message.slice(0, 60)}`)
    }
  }
  return lines.join('\n')
}

// ── Memory File Discovery ───────────────────────────────────────────────────

export interface MemoryFile {
  path: string
  content: string
  relative: string
}

export function findMemoryFiles(cwd: string): MemoryFile[] {
  const files: MemoryFile[] = []
  const candidates = [
    'CLAUDE.md',
    'AGENTS.md',
    '.ovolv999/instructions.md',
    '.ovolv999/CLAUDE.md',
    '.claude/CLAUDE.md',
  ]

  for (const candidate of candidates) {
    const fullPath = resolve(cwd, candidate)
    if (existsSync(fullPath)) {
      try {
        files.push({
          path: fullPath,
          content: readFileSync(fullPath, 'utf8'),
          relative: candidate,
        })
      } catch { /* skip */ }
    }
  }

  // Also check parent directories for CLAUDE.md
  let parent = resolve(cwd, '..')
  for (let i = 0; i < 3 && parent !== resolve(parent, '..'); i++) {
    const candidate = join(parent, 'CLAUDE.md')
    if (existsSync(candidate) && !files.some(f => f.path === candidate)) {
      try {
        files.push({
          path: candidate,
          content: readFileSync(candidate, 'utf8'),
          relative: 'parent:' + basename(parent) + '/CLAUDE.md',
        })
      } catch { /* skip */ }
    }
    parent = resolve(parent, '..')
  }

  return files
}

// ── Project Tree ────────────────────────────────────────────────────────────

export function buildProjectTree(cwd: string, maxDepth = 2): string {
  const ignoreDirs = new Set([
    'node_modules', '.git', 'dist', 'build', '.next',
    '__pycache__', '.venv', 'venv', '.cache', 'coverage',
    '.ovolv999', '.claude',
  ])

  function walk(dir: string, depth: number, prefix: string): string[] {
    if (depth > maxDepth) return []
    const lines: string[] = []

    let entries: string[]
    try {
      entries = readdirSync(dir).sort()
    } catch {
      return []
    }

    const visible = entries.filter(e => !ignoreDirs.has(e) && !e.startsWith('.'))
    const maxShow = depth === 0 ? 20 : 10
    const shown = visible.slice(0, maxShow)
    const hidden = visible.length - shown.length

    for (let i = 0; i < shown.length; i++) {
      const entry = shown[i]
      const isLast = i === shown.length - 1 && hidden === 0
      const connector = isLast ? '└── ' : '├── '
      const fullPath = join(dir, entry)

      let isDir = false
      try { isDir = existsSync(fullPath) && readdirSync(fullPath) !== undefined } catch { /* */ }

      lines.push(`${prefix}${connector}${entry}${isDir ? '/' : ''}`)

      if (isDir && depth < maxDepth) {
        const newPrefix = prefix + (isLast ? '    ' : '│   ')
        lines.push(...walk(fullPath, depth + 1, newPrefix))
      }
    }

    if (hidden > 0) {
      lines.push(`${prefix}└── ... and ${hidden} more`)
    }

    return lines
  }

  const lines = walk(cwd, 0, '')
  return lines.length > 0 ? `${basename(cwd)}/\n${lines.join('\n')}` : basename(cwd)
}

// ── System Prompt Assembly ──────────────────────────────────────────────────

export function buildSystemPrompt(options: SystemPromptOptions): string {
  const {
    cwd,
    modePrompt,
    taskContext,
    customInstructions,
    includeGitStatus = true,
    includeProjectTree = false,
    maxTreeDepth = 2,
  } = options

  const sections: string[] = []

  // 1. Base system prompt
  sections.push(BASE_SYSTEM_PROMPT)

  // 2. Mode-specific prompt
  if (modePrompt) {
    sections.push(modePrompt)
  }

  // 3. Project context
  const projectContext = buildProjectContext(cwd, {
    includeGitStatus,
    includeProjectTree,
    maxTreeDepth,
  })
  if (projectContext) {
    sections.push(projectContext)
  }

  // 4. Memory files
  const memoryFiles = findMemoryFiles(cwd)
  if (memoryFiles.length > 0) {
    sections.push(formatMemoryFiles(memoryFiles))
  }

  // 5. Task context
  if (taskContext) {
    sections.push(`# Current Task\n\n${taskContext}`)
  }

  // 6. Custom instructions
  if (customInstructions) {
    sections.push(`# Additional Instructions\n\n${customInstructions}`)
  }

  // 7. Current date
  sections.push(`Current date: ${new Date().toISOString().slice(0, 10)}`)

  return sections.join('\n\n---\n\n')
}

export function buildProjectContext(
  cwd: string,
  options: { includeGitStatus?: boolean; includeProjectTree?: boolean; maxTreeDepth?: number } = {},
): string {
  const lines: string[] = []

  lines.push(`Working directory: ${cwd}`)

  if (options.includeGitStatus) {
    const gitInfo = getGitStatusInfo(cwd)
    if (gitInfo.branch) {
      lines.push(formatGitStatus(gitInfo))
    }
  }

  if (options.includeProjectTree) {
    const tree = buildProjectTree(cwd, options.maxTreeDepth)
    lines.push(`Project structure:\n\`\`\`\n${tree}\n\`\`\``)
  }

  return lines.join('\n')
}

export function formatMemoryFiles(files: MemoryFile[]): string {
  const lines: string[] = ['# Project Memory Files']
  for (const file of files) {
    lines.push(`\n## ${file.relative}\n`)
    lines.push(file.content.trim())
  }
  return lines.join('\n')
}

// ── Base System Prompt ──────────────────────────────────────────────────────

export const BASE_SYSTEM_PROMPT = `You are ovolv999, an interactive CLI tool that helps users with software engineering tasks. You are powered by a large language model and have access to tools for reading, writing, and executing code.

## Core Capabilities

- Read and understand code across many languages
- Write, edit, and debug code
- Execute shell commands and scripts
- Search through codebases using glob and grep
- Work with git repositories
- Provide explanations and documentation
- Help with architecture and design decisions

## Guidelines

1. **Be concise and direct.** Answer the specific question asked.
2. **Show code, not just descriptions.** Use code blocks with appropriate language tags.
3. **Verify before claiming.** Read files and run commands to confirm your understanding.
4. **Follow existing patterns.** Look at neighboring code for conventions.
5. **Ask for clarification** when the request is ambiguous.
6. **Explain trade-offs** when recommending approaches.
7. **Consider edge cases** — null, empty, boundary values, concurrent access.
8. **Security first.** Never expose secrets, never commit sensitive data.
9. **Test your changes** when possible.
10. **Use tools efficiently** — batch related reads, avoid unnecessary calls.`
