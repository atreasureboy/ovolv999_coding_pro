import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { runDoctorChecks, formatDoctorReport, type DoctorReport } from '../src/utils/doctor.js'

// ── Helpers ─────────────────────────────────────────────────────────────────

function initGitRepo(dir: string): void {
  execSync('git init -b main', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' })
  writeFileSync(join(dir, 'README.md'), '# test\n')
  execSync('git add -A && git commit -m init', { cwd: dir, stdio: 'pipe' })
}

function findResult(report: DoctorReport, category: string, item?: string) {
  return report.results.find(r =>
    r.category === category && (item === undefined || r.item === item),
  )
}

// ── runDoctorChecks ─────────────────────────────────────────────────────────

describe('runDoctorChecks', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'doctor-'))
  })

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('returns a report with results', () => {
    const report = runDoctorChecks(dir)
    expect(report.results.length).toBeGreaterThan(0)
    expect(report.counts.ok + report.counts.warning + report.counts.error).toBe(report.results.length)
  })

  it('detects missing API key as error', () => {
    const origKey = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    // Also remove other provider keys
    const keysToDelete = ['ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'GROQ_API_KEY']
    const origValues: Record<string, string | undefined> = {}
    for (const k of keysToDelete) {
      origValues[k] = process.env[k]
      delete process.env[k]
    }

    const report = runDoctorChecks(dir)
    const apiKeyResult = findResult(report, 'env', 'api-key')
    expect(apiKeyResult?.level).toBe('error')

    // Restore
    if (origKey) process.env.OPENAI_API_KEY = origKey
    for (const [k, v] of Object.entries(origValues)) {
      if (v) process.env[k] = v
    }
  })

  it('detects git repository', () => {
    initGitRepo(dir)
    const report = runDoctorChecks(dir)
    const gitResult = findResult(report, 'git', 'repo')
    expect(gitResult?.level).toBe('ok')
  })

  it('warns when not a git repo', () => {
    const report = runDoctorChecks(dir)
    const gitResult = findResult(report, 'git', 'repo')
    expect(gitResult?.level).toBe('warning')
  })

  it('detects clean working tree', () => {
    initGitRepo(dir)
    const report = runDoctorChecks(dir)
    const statusResult = findResult(report, 'git', 'status')
    expect(statusResult?.level).toBe('ok')
    expect(statusResult?.message).toContain('clean')
  })

  it('warns on uncommitted changes', () => {
    initGitRepo(dir)
    writeFileSync(join(dir, 'new.txt'), 'content')
    const report = runDoctorChecks(dir)
    const statusResult = findResult(report, 'git', 'status')
    expect(statusResult?.level).toBe('warning')
  })

  it('detects project type', () => {
    writeFileSync(join(dir, 'package.json'), '{"name":"test"}')
    const report = runDoctorChecks(dir)
    const projectResult = findResult(report, 'project', 'type')
    expect(projectResult?.level).toBe('ok')
    expect(projectResult?.message).toContain('Node.js')
  })

  it('detects TypeScript project', () => {
    writeFileSync(join(dir, 'tsconfig.json'), '{}')
    const report = runDoctorChecks(dir)
    const projectResult = findResult(report, 'project', 'type')
    expect(projectResult?.message).toContain('TypeScript')
  })

  it('warns when no project markers', () => {
    const report = runDoctorChecks(dir)
    const projectResult = findResult(report, 'project', 'type')
    expect(projectResult?.level).toBe('warning')
  })

  it('checks keybindings config', () => {
    mkdirSync(join(dir, '.ovolv999'), { recursive: true })
    writeFileSync(
      join(dir, '.ovolv999', 'keybindings.json'),
      JSON.stringify({ bindings: { 'unknown-action': 'ctrl+x' } }),
    )
    const report = runDoctorChecks(dir)
    const kbResult = report.results.find(r => r.category === 'keybindings' && r.level === 'error')
    expect(kbResult).toBeDefined()
  })

  it('validates workflows', () => {
    mkdirSync(join(dir, '.ovolv999', 'workflows'), { recursive: true })
    writeFileSync(
      join(dir, '.ovolv999', 'workflows', 'test.json'),
      JSON.stringify({
        name: 'test',
        steps: [{ name: 'bad', type: 'shell' }], // missing command
      }),
    )
    const report = runDoctorChecks(dir)
    const wfResult = report.results.find(r => r.category === 'workflows' && r.item === 'test')
    expect(wfResult?.level).toBe('warning')
  })

  it('passed is false when errors exist', () => {
    const origKey = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    const keysToDelete = ['ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'GROQ_API_KEY']
    const origValues: Record<string, string | undefined> = {}
    for (const k of keysToDelete) {
      origValues[k] = process.env[k]
      delete process.env[k]
    }

    const report = runDoctorChecks(dir)
    expect(report.passed).toBe(false)
    expect(report.counts.error).toBeGreaterThan(0)

    if (origKey) process.env.OPENAI_API_KEY = origKey
    for (const [k, v] of Object.entries(origValues)) {
      if (v) process.env[k] = v
    }
  })

  it('passed is true when no errors', () => {
    initGitRepo(dir)
    writeFileSync(join(dir, 'package.json'), '{}')
    // Set a key temporarily
    const origKey = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'test-key'

    const report = runDoctorChecks(dir)
    expect(report.counts.error).toBe(0)
    expect(report.passed).toBe(true)

    if (origKey) process.env.OPENAI_API_KEY = origKey
    else delete process.env.OPENAI_API_KEY
  })

  it('includes cwd in report', () => {
    const report = runDoctorChecks(dir)
    expect(report.cwd).toContain(dir)
  })
})

// ── formatDoctorReport ──────────────────────────────────────────────────────

describe('formatDoctorReport', () => {
  it('includes summary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fmt-'))
    try {
      const report = runDoctorChecks(dir)
      const text = formatDoctorReport(report)
      expect(text).toContain('SUMMARY')
      expect(text).toContain('Total checks')
      expect(text).toContain('Passed')
      expect(text).toContain('Warnings')
      expect(text).toContain('Errors')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uses icons for levels', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fmt2-'))
    try {
      const report = runDoctorChecks(dir)
      const text = formatDoctorReport(report)
      // Should have at least one of each icon
      expect(text).toMatch(/[✓⚠✗]/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('groups by category', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fmt3-'))
    try {
      const report = runDoctorChecks(dir)
      const text = formatDoctorReport(report)
      expect(text).toContain('GIT')
      expect(text).toContain('PROJECT')
      expect(text).toContain('ENV')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('shows pass/fail message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fmt4-'))
    try {
      const report = runDoctorChecks(dir)
      const text = formatDoctorReport(report)
      expect(text).toMatch(/(All checks passed|error\(s\) found)/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('includes fix suggestions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fmt5-'))
    try {
      // No API key, no git → should have fix suggestions
      const origKey = process.env.OPENAI_API_KEY
      delete process.env.OPENAI_API_KEY
      const keysToDelete = ['ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'GROQ_API_KEY']
      const origValues: Record<string, string | undefined> = {}
      for (const k of keysToDelete) {
        origValues[k] = process.env[k]
        delete process.env[k]
      }

      const report = runDoctorChecks(dir)
      const text = formatDoctorReport(report)
      expect(text).toContain('fix:')

      if (origKey) process.env.OPENAI_API_KEY = origKey
      for (const [k, v] of Object.entries(origValues)) {
        if (v) process.env[k] = v
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
