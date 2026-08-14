/**
 * Project Doctor — validates all .ovolv999/ configuration files.
 *
 * Scans keybindings, workflows, skills, and project settings, then
 * reports any issues found.
 *
 * Inspired by Claude Code's setup validation and npm doctor.
 */

import { existsSync, readdirSync, statSync } from 'fs'
import { join, resolve, extname } from 'path'
import { execSync } from 'child_process'
import { loadKeybindings } from '../ui/keybindings.js'
import { loadWorkflows } from '../core/workflow.js'
import { loadSkills } from '../skills/loader.js'

// ── Types ───────────────────────────────────────────────────────────────────

export type CheckLevel = 'ok' | 'warning' | 'error'

export interface CheckResult {
  /** Category name */
  category: string
  /** Specific item name */
  item: string
  /** Result level */
  level: CheckLevel
  /** Human-readable message */
  message: string
  /** Optional fix suggestion */
  fix?: string
}

export interface DoctorReport {
  results: CheckResult[]
  /** Count by level */
  counts: { ok: number; warning: number; error: number }
  /** Whether the project passed all checks */
  passed: boolean
  /** Path to the project */
  cwd: string
}

// ── Main Entry ──────────────────────────────────────────────────────────────

/**
 * Run all configuration checks for a project.
 */
export function runDoctorChecks(cwd: string): DoctorReport {
  const absCwd = resolve(cwd)
  const results: CheckResult[] = []

  // 1. Check .ovolv999 directory structure
  checkDirectoryStructure(absCwd, results)

  // 2. Keybindings
  checkKeybindings(absCwd, results)

  // 3. Workflows
  checkWorkflows(absCwd, results)

  // 4. Skills
  checkSkills(absCwd, results)

  // 5. Git status
  checkGit(absCwd, results)

  // 7. Environment
  checkEnvironment(absCwd, results)

  // 8. Project files
  checkProjectFiles(absCwd, results)

  const counts = { ok: 0, warning: 0, error: 0 }
  for (const r of results) {
    counts[r.level]++
  }

  return {
    results,
    counts,
    passed: counts.error === 0,
    cwd: absCwd,
  }
}

// ── Individual Checks ───────────────────────────────────────────────────────

function checkDirectoryStructure(cwd: string, results: CheckResult[]): void {
  const ovolvDir = join(cwd, '.ovolv999')

  if (!existsSync(ovolvDir)) {
    results.push({
      category: 'structure',
      item: '.ovolv999',
      level: 'ok',
      message: 'No .ovolv999 directory (using defaults for all configs)',
    })
    return
  }

  // Skills live under `.ovogo/skills/` (see skills/loader.ts + the dedicated
  // checkSkills() below), NOT under `.ovolv999/`. Only workflows and worktrees
  // are real `.ovolv999/` subdirs — listing 'skills' here checked a dir the
  // project never writes, a stale entry from the pre-brand-split layout.
  const expectedSubdirs = ['workflows', 'worktrees']
  for (const sub of expectedSubdirs) {
    const path = join(ovolvDir, sub)
    if (existsSync(path)) {
      const items = readdirSync(path)
      results.push({
        category: 'structure',
        item: `.ovolv999/${sub}`,
        level: 'ok',
        message: `${items.length} item(s)`,
      })
    }
  }
}

function checkKeybindings(cwd: string, results: CheckResult[]): void {
  const result = loadKeybindings(cwd)

  if (!result.hasUserConfig) {
    results.push({
      category: 'keybindings',
      item: 'config',
      level: 'ok',
      message: 'Using default keybindings',
    })
    return
  }

  for (const err of result.errors) {
    results.push({
      category: 'keybindings',
      item: 'config',
      level: 'error',
      message: err,
      fix: 'Edit .ovolv999/keybindings.json or run /keybindings reset',
    })
  }

  for (const conflict of result.conflicts) {
    results.push({
      category: 'keybindings',
      item: conflict.key,
      level: 'warning',
      message: `Conflict: ${conflict.key} → ${conflict.actions.join(', ')}`,
      fix: 'Use a different key combo for one of the actions',
    })
  }

  if (result.errors.length === 0 && result.conflicts.length === 0) {
    results.push({
      category: 'keybindings',
      item: 'config',
      level: 'ok',
      message: 'Custom keybindings loaded successfully',
    })
  }
}

function checkWorkflows(cwd: string, results: CheckResult[]): void {
  const workflows = loadWorkflows(cwd)

  if (workflows.size === 0) {
    results.push({
      category: 'workflows',
      item: 'config',
      level: 'ok',
      message: 'No workflows defined (create with /workflow init)',
    })
    return
  }

  for (const [name, wf] of workflows) {
    const issues: string[] = []
    for (const step of wf.steps) {
      if (step.type === 'shell' && !step.command) {
        issues.push(`step "${step.name ?? step.type}" missing command`)
      }
      if (step.type === 'slash' && !step.command) {
        issues.push(`step "${step.name ?? step.type}" missing command`)
      }
      if (step.type === 'echo' && !step.text) {
        issues.push(`step "${step.name ?? step.type}" missing text`)
      }
    }

    if (issues.length > 0) {
      results.push({
        category: 'workflows',
        item: name,
        level: 'warning',
        message: issues.join('; '),
      })
    } else {
      results.push({
        category: 'workflows',
        item: name,
        level: 'ok',
        message: `${wf.steps.length} step(s)`,
      })
    }
  }
}

function checkSkills(cwd: string, results: CheckResult[]): void {
  const skillsDir = join(cwd, '.ovogo', 'skills')

  if (!existsSync(skillsDir)) {
    results.push({
      category: 'skills',
      item: 'config',
      level: 'ok',
      message: 'No custom skills (create with /skill-save)',
    })
    return
  }

  let mdFiles: string[]
  try {
    mdFiles = readdirSync(skillsDir).filter(f => extname(f) === '.md')
  } catch {
    results.push({
      category: 'skills',
      item: 'config',
      level: 'error',
      message: 'Failed to read skills directory',
    })
    return
  }

  if (mdFiles.length === 0) {
    results.push({
      category: 'skills',
      item: 'config',
      level: 'ok',
      message: 'No skill files found',
    })
    return
  }

  for (const file of mdFiles) {
    try {
      const skills = loadSkills(cwd)
      const skillsArray = [...skills.values()]
      const matching = skillsArray.find(s => file.includes(s.name))
      if (matching) {
        results.push({
          category: 'skills',
          item: matching.name,
          level: 'ok',
          message: matching.description.slice(0, 60),
        })
      } else {
        results.push({
          category: 'skills',
          item: file,
          level: 'warning',
          message: 'File exists but skill not loaded (may have invalid frontmatter)',
        })
      }
    } catch {
      results.push({
        category: 'skills',
        item: file,
        level: 'warning',
        message: 'Failed to parse skill file',
      })
    }
  }
}

function checkGit(cwd: string, results: CheckResult[]): void {
  try {
    execSync('git rev-parse --git-dir', { cwd, stdio: 'pipe' })

    results.push({
      category: 'git',
      item: 'repo',
      level: 'ok',
      message: 'Git repository detected',
    })

    // Check for uncommitted changes
    try {
      const status = execSync('git status --porcelain', {
        cwd, encoding: 'utf8', stdio: 'pipe',
      }).trim()
      if (status) {
        const lines = status.split('\n').filter(Boolean)
        results.push({
          category: 'git',
          item: 'status',
          level: 'warning',
          message: `${lines.length} uncommitted change(s)`,
        })
      } else {
        results.push({
          category: 'git',
          item: 'status',
          level: 'ok',
          message: 'Working tree clean',
        })
      }
    } catch { /* best-effort */ }
  } catch {
    results.push({
      category: 'git',
      item: 'repo',
      level: 'warning',
      message: 'Not a git repository (worktrees and some features unavailable)',
    })
  }
}

function checkEnvironment(cwd: string, results: CheckResult[]): void {
  // Check for API key
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    // Check for other provider keys
    const otherKeys = [
      'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'XAI_API_KEY',
      'DEEPSEEK_API_KEY', 'GROQ_API_KEY',
    ]
    const found = otherKeys.find(k => process.env[k])
    if (found) {
      results.push({
        category: 'env',
        item: 'api-key',
        level: 'ok',
        message: `Using ${found}`,
      })
    } else {
      results.push({
        category: 'env',
        item: 'api-key',
        level: 'error',
        message: 'No API key found in environment',
        fix: 'Set OPENAI_API_KEY or another provider key',
      })
    }
  } else {
    results.push({
      category: 'env',
      item: 'api-key',
      level: 'ok',
      message: 'OPENAI_API_KEY is set',
    })
  }

  // Check for editor
  const editor = process.env.EDITOR ?? process.env.VISUAL
  if (!editor) {
    results.push({
      category: 'env',
      item: 'editor',
      level: 'warning',
      message: 'No $EDITOR or $VISUAL set (Ctrl+G will use vim as fallback)',
    })
  } else {
    results.push({
      category: 'env',
      item: 'editor',
      level: 'ok',
      message: `Editor: ${editor}`,
    })
  }
}

function checkProjectFiles(cwd: string, results: CheckResult[]): void {
  // Check for common project files
  const markers = [
    { file: 'package.json', label: 'Node.js project' },
    { file: 'tsconfig.json', label: 'TypeScript project' },
    { file: 'pyproject.toml', label: 'Python project' },
    { file: 'Cargo.toml', label: 'Rust project' },
    { file: 'go.mod', label: 'Go project' },
    { file: 'pom.xml', label: 'Maven Java project' },
    { file: 'build.gradle', label: 'Gradle project' },
    { file: '.gitignore', label: 'Git ignore rules' },
  ]

  const found: string[] = []
  for (const { file, label } of markers) {
    if (existsSync(join(cwd, file))) {
      found.push(label)
    }
  }

  if (found.length > 0) {
    results.push({
      category: 'project',
      item: 'type',
      level: 'ok',
      message: `Detected: ${found.join(', ')}`,
    })
  } else {
    results.push({
      category: 'project',
      item: 'type',
      level: 'warning',
      message: 'No project markers found (package.json, Cargo.toml, etc.)',
    })
  }

  // Check .ovolv999 file size (large configs can slow startup)
  const configDir = join(cwd, '.ovolv999')
  if (existsSync(configDir)) {
    try {
      const stats = statSync(configDir)
      if (stats.isDirectory()) {
        // Check total size of all config files
        let totalSize = 0
        const allFiles = readdirSync(configDir, { recursive: true }) as string[]
        for (const f of allFiles) {
          try {
            totalSize += statSync(join(configDir, f)).size
          } catch { /* best-effort */ }
        }
        if (totalSize > 1_000_000) {
          results.push({
            category: 'project',
            item: 'config-size',
            level: 'warning',
            message: `Config directory is large (${(totalSize / 1_000_000).toFixed(1)}MB)`,
            fix: 'Consider cleaning up old files in .ovolv999/',
          })
        }
      }
    } catch { /* best-effort */ }
  }
}

// ── Formatting ──────────────────────────────────────────────────────────────

/**
 * Format a doctor report as human-readable text.
 */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [
    `Project Doctor — ${report.cwd}`,
    '',
  ]

  // Group by category
  const byCategory = new Map<string, CheckResult[]>()
  for (const r of report.results) {
    const list = byCategory.get(r.category) ?? []
    list.push(r)
    byCategory.set(r.category, list)
  }

  for (const [category, items] of byCategory) {
    lines.push(`── ${category.toUpperCase()} ──`)
    for (const item of items) {
      const icon = item.level === 'ok' ? '✓' : item.level === 'warning' ? '⚠' : '✗'
      const name = item.item.padEnd(20)
      lines.push(`  ${icon} ${name} ${item.message}`)
      if (item.fix) {
        lines.push(`    fix: ${item.fix}`)
      }
    }
    lines.push('')
  }

  // Summary
  const { ok, warning, error } = report.counts
  const total = ok + warning + error
  lines.push(`── SUMMARY ──`)
  lines.push(`  Total checks: ${total}`)
  lines.push(`  ✓ Passed:     ${ok}`)
  lines.push(`  ⚠ Warnings:   ${warning}`)
  lines.push(`  ✗ Errors:     ${error}`)
  lines.push('')
  lines.push(report.passed
    ? '✓ All checks passed!'
    : `✗ ${error} error(s) found. Run the suggested fixes.`)

  return lines.join('\n')
}
