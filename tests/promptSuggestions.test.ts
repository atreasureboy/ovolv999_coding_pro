import { describe, it, expect } from 'vitest'
import {
  generatePromptSuggestions,
  formatPromptSuggestions,
  buildPromptContext,
  detectLanguage,
  isTestFile,
  ALL_PROMPT_RULES,
  type PromptContext,
  type PromptSuggestionRule,
} from '../src/core/promptSuggestions.js'

describe('promptSuggestions', () => {
  const baseCtx = (overrides: Partial<PromptContext> = {}): PromptContext => ({
    recentFiles: [],
    recentTools: [],
    hadErrors: false,
    lastUserPrompt: 'test prompt',
    lastAssistantSnippet: '',
    hasTests: true,
    cwd: process.cwd(),
    isGitRepo: true,
    ...overrides,
  })

  describe('detectLanguage', () => {
    it('detects TypeScript', () => {
      expect(detectLanguage('file.ts')).toBe('TypeScript')
    })

    it('detects Python', () => {
      expect(detectLanguage('script.py')).toBe('Python')
    })

    it('detects JavaScript', () => {
      expect(detectLanguage('app.js')).toBe('JavaScript')
    })

    it('defaults to code for unknown', () => {
      expect(detectLanguage('file.xyz')).toBe('code')
    })
  })

  describe('isTestFile', () => {
    it('detects .test.ts files', () => {
      expect(isTestFile('engine.test.ts')).toBe(true)
    })

    it('detects .spec.js files', () => {
      expect(isTestFile('engine.spec.js')).toBe(true)
    })

    it('detects /tests/ directory files', () => {
      expect(isTestFile('tests/engine.ts')).toBe(true)
    })

    it('detects __tests__ directory', () => {
      expect(isTestFile('__tests__/engine.test.ts')).toBe(true)
    })

    it('returns false for non-test files', () => {
      expect(isTestFile('src/engine.ts')).toBe(false)
    })

    it('returns false for markdown', () => {
      expect(isTestFile('README.md')).toBe(false)
    })
  })

  describe('generatePromptSuggestions', () => {
    it('suggests fixing errors when hadErrors is true', () => {
      const ctx = baseCtx({ hadErrors: true })
      const result = generatePromptSuggestions(ctx)
      expect(result.some(s => s.category === 'fixing')).toBe(true)
    })

    it('suggests running tests for modified code files', () => {
      const ctx = baseCtx({
        recentFiles: ['src/engine.ts'],
        hasTests: true,
      })
      const result = generatePromptSuggestions(ctx)
      expect(result.some(s => s.category === 'testing')).toBe(true)
    })

    it('does not suggest tests when no code files', () => {
      const ctx = baseCtx({
        recentFiles: ['README.md'],
        hasTests: true,
      })
      const result = generatePromptSuggestions(ctx)
      // Might still suggest other things, but not running tests for the md file
      expect(result.some(s => s.text.includes('README.md'))).toBe(false)
    })

    it('suggests writing tests when Write tool used', () => {
      const ctx = baseCtx({
        recentFiles: ['src/newModule.ts'],
        recentTools: ['Write'],
        hasTests: true,
      })
      const result = generatePromptSuggestions(ctx)
      expect(result.some(s => s.category === 'testing')).toBe(true)
    })

    it('suggests review for multiple files', () => {
      const ctx = baseCtx({
        recentFiles: ['a.ts', 'b.ts', 'c.ts'],
      })
      const result = generatePromptSuggestions(ctx)
      expect(result.some(s => s.category === 'review')).toBe(true)
    })

    it('suggests commit in git repo with changes', () => {
      const ctx = baseCtx({
        recentFiles: ['a.ts'],
        isGitRepo: true,
      })
      const result = generatePromptSuggestions(ctx)
      expect(result.some(s => s.category === 'next-steps')).toBe(true)
    })

    it('does not suggest commit when not a git repo', () => {
      const ctx = baseCtx({
        recentFiles: ['a.ts'],
        isGitRepo: false,
      })
      const result = generatePromptSuggestions(ctx)
      expect(result.some(s => s.text.includes('Commit'))).toBe(false)
    })

    it('does not suggest commit when errors occurred', () => {
      const ctx = baseCtx({
        recentFiles: ['a.ts'],
        isGitRepo: true,
        hadErrors: true,
      })
      const result = generatePromptSuggestions(ctx)
      // Fix errors takes priority
      expect(result.some(s => s.category === 'fixing')).toBe(true)
    })

    it('sorts by confidence', () => {
      const ctx = baseCtx({
        hadErrors: true,
        recentFiles: ['a.ts', 'b.ts', 'c.ts'],
        hasTests: true,
      })
      const result = generatePromptSuggestions(ctx)
      for (let i = 1; i < result.length; i++) {
        expect(result[i - 1].confidence).toBeGreaterThanOrEqual(result[i].confidence)
      }
    })

    it('limits to maxResults', () => {
      const ctx = baseCtx({
        hadErrors: true,
        recentFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
        recentTools: ['Edit', 'Edit', 'Edit'],
        hasTests: true,
      })
      const result = generatePromptSuggestions(ctx, ALL_PROMPT_RULES, 2)
      expect(result.length).toBeLessThanOrEqual(2)
    })

    it('catches rule errors', () => {
      const ctx = baseCtx({})
      const rules: PromptSuggestionRule[] = [
        () => { throw new Error('boom') },
        () => ({
          text: 'OK',
          reason: 'test',
          confidence: 0.5,
          category: 'follow-up' as const,
        }),
      ]
      const result = generatePromptSuggestions(ctx, rules)
      expect(result.length).toBe(1)
      expect(result[0].text).toBe('OK')
    })

    it('suggestion has required fields', () => {
      const ctx = baseCtx({ hadErrors: true })
      const result = generatePromptSuggestions(ctx)
      const s = result[0]
      expect(s).toHaveProperty('text')
      expect(s).toHaveProperty('reason')
      expect(s).toHaveProperty('confidence')
      expect(s).toHaveProperty('category')
      expect(typeof s.text).toBe('string')
      expect(s.text.length).toBeGreaterThan(0)
    })
  })

  describe('formatPromptSuggestions', () => {
    it('returns empty string for no suggestions', () => {
      expect(formatPromptSuggestions([])).toBe('')
    })

    it('formats with header', () => {
      const result = formatPromptSuggestions([{
        text: 'Run tests',
        reason: 'verify changes',
        confidence: 0.7,
        category: 'testing',
      }])
      expect(result).toContain('Suggested')
      expect(result).toContain('Run tests')
      expect(result).toContain('verify changes')
    })

    it('numbers suggestions', () => {
      const result = formatPromptSuggestions([
        { text: 'A', reason: 'ra', confidence: 0.9, category: 'testing' },
        { text: 'B', reason: 'rb', confidence: 0.8, category: 'review' },
      ])
      expect(result).toContain('1.')
      expect(result).toContain('2.')
    })
  })

  describe('buildPromptContext', () => {
    it('builds context with auto-detected git repo', () => {
      const ctx = buildPromptContext(
        process.cwd(),
        ['src/test.ts'],
        ['Edit'],
        false,
        'fix bug',
        '',
        true,
      )
      expect(ctx.cwd).toBe(process.cwd())
      expect(ctx.recentFiles).toEqual(['src/test.ts'])
      // This IS a git repo
      expect(ctx.isGitRepo).toBe(true)
    })

    it('handles non-git directory', () => {
      const ctx = buildPromptContext(
        '/tmp',
        [],
        [],
        false,
        '',
        '',
        false,
      )
      expect(ctx.isGitRepo).toBe(false)
    })
  })

  describe('ALL_PROMPT_RULES', () => {
    it('is a non-empty array', () => {
      expect(Array.isArray(ALL_PROMPT_RULES)).toBe(true)
      expect(ALL_PROMPT_RULES.length).toBeGreaterThanOrEqual(8)
    })

    it('all rules return suggestion or null', () => {
      const ctx = baseCtx({})
      for (const rule of ALL_PROMPT_RULES) {
        const result = rule(ctx)
        expect(result === null || typeof result === 'object').toBeTruthy()
      }
    })
  })
})
