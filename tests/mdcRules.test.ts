/**
 * v0.5.2 (C11 — borrowed from cursor .mdc rule format):
 * tests for the cursor-style .mdc rule loader.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  parseMdcRule,
  loadRules,
  activateRules,
  renderForPrompt,
} from '../src/core/mdcRules.js'

describe('.mdc rule loader (C11)', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ovolv999-mdc-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('parses a simple .mdc file with frontmatter', () => {
    const rulePath = join(tmp, 'no-console.mdc')
    writeFileSync(rulePath,
      '---\n' +
      'description: Forbid console.log in source files\n' +
      'globs: [src/**/*.ts, lib/**/*.ts]\n' +
      'activation: auto\n' +
      '---\n' +
      'Never use console.log in production code; use the logger module instead.\n',
    )
    const rule = parseMdcRule(rulePath)
    expect(rule).not.toBeNull()
    expect(rule!.id).toBe('no-console')
    expect(rule!.description).toBe('Forbid console.log in source files')
    expect(rule!.globs).toEqual(['src/**/*.ts', 'lib/**/*.ts'])
    expect(rule!.activation).toBe('auto')
    expect(rule!.body).toContain('Never use console.log')
  })

  it('parses frontmatter with agent filter', () => {
    const rulePath = join(tmp, 'review-checklist.mdc')
    writeFileSync(rulePath,
      '---\n' +
      'description: Reviewer-only checklist\n' +
      'activation: agent\n' +
      'agent: reviewer\n' +
      '---\n' +
      'Verify every changed file has a test.\n',
    )
    const rule = parseMdcRule(rulePath)
    expect(rule!.activation).toBe('agent')
    expect(rule!.agentRole).toBe('reviewer')
  })

  it('handles .mdc files without frontmatter', () => {
    const rulePath = join(tmp, 'plain.mdc')
    writeFileSync(rulePath, 'Just plain markdown without any frontmatter.\n')
    const rule = parseMdcRule(rulePath)
    expect(rule).not.toBeNull()
    expect(rule!.body).toContain('Just plain markdown')
    expect(rule!.activation).toBe('always') // default
  })

  it('returns null for non-existent files', () => {
    expect(parseMdcRule('/this/path/does/not/exist.mdc')).toBeNull()
  })

  it('loadRules discovers both user-level and cwd rules', () => {
    const userDir = join(tmp, 'user')
    const cwdDir = join(tmp, 'cwd', '.ovolv999', 'rules')
    mkdirSync(userDir, { recursive: true })
    mkdirSync(cwdDir, { recursive: true })
    writeFileSync(join(userDir, 'user-rule.mdc'),
      '---\ndescription: User-level rule\n---\nUser body.\n',
    )
    writeFileSync(join(cwdDir, 'cwd-rule.mdc'),
      '---\ndescription: CWD-level rule\n---\nCWD body.\n',
    )
    const rules = loadRules({ cwd: join(tmp, 'cwd'), userDir })
    expect(rules.length).toBe(2)
    expect(rules[0].id).toBe('user-rule')
    expect(rules[1].id).toBe('cwd-rule')
  })

  it('activateRules respects activation modes', () => {
    const rules = [
      { id: 'always', path: '/x', description: '', globs: [], activation: 'always' as const, body: 'a' },
      { id: 'auto', path: '/x', description: '', globs: ['src/**/*.ts'], activation: 'auto' as const, body: 'b' },
      { id: 'agent', path: '/x', description: '', globs: [], activation: 'agent' as const, agentRole: 'reviewer', body: 'c' },
      { id: 'decisions', path: '/x', description: '', globs: [], activation: 'decisions' as const, body: 'd' },
    ]
    const activated = activateRules(rules, {
      cwd: '/proj/src/foo.ts',
      agentRole: 'reviewer',
      globMatch: (pat: string, val: string) => pat === 'src/**/*.ts' && val.includes('/src/'),
    })
    expect(activated.map((r) => r.id)).toEqual(['always', 'auto', 'agent'])
  })

  it('activateRules auto-mode matches globs when a matcher is supplied', () => {
    const rules = [
      { id: 'auto-src', path: '/x', description: '', globs: ['src/**/*.ts'], activation: 'auto' as const, body: 'a' },
    ]
    const matcher = (pat: string, val: string) => pat === 'src/**/*.ts' && val.startsWith('src/')
    const activated = activateRules(rules, {
      cwd: 'src/foo.ts',
      globMatch: matcher,
    })
    expect(activated.length).toBe(1)
    expect(activated[0].reason).toContain('matched')
  })

  it('renderForPrompt emits a clean markdown block', () => {
    const rules = [{
      id: 'r1', path: '/x', description: 'desc',
      globs: [], activation: 'always' as const, body: 'body text',
      reason: 'always-on',
    }]
    const md = renderForPrompt(rules)
    expect(md).toContain('## Active Project Rules')
    expect(md).toContain('### r1 — desc')
    expect(md).toContain('body text')
  })

  it('renderForPrompt returns empty string for no rules', () => {
    expect(renderForPrompt([])).toBe('')
  })
})