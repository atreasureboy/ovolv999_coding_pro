/**
 * Project context detector — auto-detects project type, scripts, git state.
 * Injected into system prompt so the LLM knows what it's working with.
 */

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'

export interface ProjectContext {
  language?: string
  packageManager?: string
  scripts?: {
    build?: string
    test?: string
    lint?: string
    format?: string
    dev?: string
  }
  framework?: string
  git?: {
    branch?: string
    modifiedCount?: number
    stagedCount?: number
    recentCommits?: string[]
  }
}

function tryReadJSON(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function tryExec(cmd: string, cwd: string): string | null {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim()
  } catch {
    return null
  }
}

/** Detect project context from cwd */
export function detectProjectContext(cwd: string): ProjectContext {
  const ctx: ProjectContext = {}

  // Package.json
  const pkgPath = join(cwd, 'package.json')
  if (existsSync(pkgPath)) {
    const pkg = tryReadJSON(pkgPath)
    if (pkg) {
      ctx.language = 'TypeScript/JavaScript'

      // Detect scripts
      const scripts = pkg.scripts as Record<string, string> | undefined
      if (scripts) {
        ctx.scripts = {
          build: scripts.build,
          test: scripts.test,
          lint: scripts.lint,
          format: scripts.format,
          dev: scripts.dev,
        }
      }

      // Detect framework
      const deps = { ...(pkg.dependencies as Record<string, string> ?? {}), ...(pkg.devDependencies as Record<string, string> ?? {}) }
      if (deps.next) ctx.framework = 'Next.js'
      else if (deps.vite) ctx.framework = 'Vite'
      else if (deps.react) ctx.framework = 'React'
      else if (deps.express) ctx.framework = 'Express'
      else if (deps.fastapi ?? deps.flask) ctx.framework = 'Python Web'
    }
  }

  // Package manager
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) ctx.packageManager = 'pnpm'
  else if (existsSync(join(cwd, 'yarn.lock'))) ctx.packageManager = 'yarn'
  else if (existsSync(join(cwd, 'package-lock.json'))) ctx.packageManager = 'npm'
  else if (existsSync(join(cwd, 'bun.lockb'))) ctx.packageManager = 'bun'

  // TypeScript
  if (existsSync(join(cwd, 'tsconfig.json'))) ctx.language = 'TypeScript'

  // Python
  if (existsSync(join(cwd, 'pyproject.toml')) || existsSync(join(cwd, 'setup.py'))) {
    ctx.language = 'Python'
  }

  // Go
  if (existsSync(join(cwd, 'go.mod'))) ctx.language = 'Go'

  // Rust
  if (existsSync(join(cwd, 'Cargo.toml'))) ctx.language = 'Rust'

  // Git
  const gitBranch = tryExec('git branch --show-current', cwd)
  if (gitBranch) {
    const status = tryExec('git status --porcelain', cwd)
    const modified = status ? status.split('\n').filter(l => l.trim().startsWith(' M') || l.trim().startsWith('MM')).length : 0
    const staged = status ? status.split('\n').filter(l => l.trim().startsWith('M') || l.trim().startsWith('A')).length : 0
    const log = tryExec('git log --oneline -3', cwd)
    const commits = log ? log.split('\n').filter(Boolean) : []

    ctx.git = {
      branch: gitBranch,
      modifiedCount: modified,
      stagedCount: staged,
      recentCommits: commits,
    }
  }

  return ctx
}

/** Format project context as a system prompt section */
export function formatProjectContext(ctx: ProjectContext): string {
  const lines: string[] = ['# Project Context (Auto-detected)']

  if (ctx.language) lines.push(` - Language: ${ctx.language}`)
  if (ctx.framework) lines.push(` - Framework: ${ctx.framework}`)
  if (ctx.packageManager) lines.push(` - Package manager: ${ctx.packageManager}`)

  if (ctx.scripts) {
    const s = ctx.scripts
    const scripts: string[] = []
    if (s.build) scripts.push(`build: \`${s.build}\``)
    if (s.test) scripts.push(`test: \`${s.test}\``)
    if (s.lint) scripts.push(`lint: \`${s.lint}\``)
    if (s.format) scripts.push(`format: \`${s.format}\``)
    if (s.dev) scripts.push(`dev: \`${s.dev}\``)
    if (scripts.length > 0) {
      lines.push(` - Commands:`)
      for (const sc of scripts) lines.push(`   - ${sc}`)
    }
  }

  // Framework-specific guidance
  if (ctx.framework) {
    lines.push('')
    lines.push('## Framework Notes')
    switch (ctx.framework) {
      case 'Next.js':
        lines.push(' - App Router: components in `app/`, API routes in `app/api/`')
        lines.push(' - Use `next/script` for scripts, `next/image` for images')
        lines.push(' - Server components by default; `"use client"` for client components')
        break
      case 'Vite':
        lines.push(' - Entry: `src/main.ts`, config: `vite.config.ts`')
        lines.push(' - Dev server: `npm run dev`, build: `npm run build`')
        break
      case 'React':
        lines.push(' - Components in `src/components/`, hooks in `src/hooks/`')
        lines.push(' - Check for state management (Redux/Zustand/Context) before adding new state')
        break
      case 'Express':
        lines.push(' - Routes in `src/routes/`, middleware in `src/middleware/`')
        lines.push(' - Use asyncHandler wrapper for async route handlers')
        break
      default:
        lines.push(` - Follow existing ${ctx.framework} conventions in the codebase`)
    }
  }

  if (ctx.git) {
    lines.push('')
    lines.push('## Git Status')
    lines.push(` - Branch: ${ctx.git.branch}`)
    if (ctx.git.modifiedCount! > 0) lines.push(` - Modified: ${ctx.git.modifiedCount} files`)
    if (ctx.git.stagedCount! > 0) lines.push(` - Staged: ${ctx.git.stagedCount} files`)
    if (ctx.git.recentCommits && ctx.git.recentCommits.length > 0) {
      lines.push(` - Recent commits:`)
      for (const c of ctx.git.recentCommits) lines.push(`   - ${c}`)
    }
  }

  return lines.length > 1 ? lines.join('\n') : ''
}
