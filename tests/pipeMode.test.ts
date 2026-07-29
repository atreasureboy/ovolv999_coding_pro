/**
 * pipeMode pure units — v0.4.1 WS3 migration.
 *
 * Deleted alongside the old raw path's helpers: the executePipe,
 * gatherProjectContext and parsePipeArgs describes (bin/ovogogogo.ts
 * parseArgs is now the ONE CLI parser — see tests/parseArgsFix.test.ts;
 * the raw path survives frozen as --llm-only in the bin).
 *
 * KEPT and load-bearing:
 *   - buildPrompt  — prompt framing shared by --pipe and --llm-only
 *   - estimateTokens — --llm-only envelope stats
 *   - formatPipeOutput — the FROZEN sshRemote envelope keys
 *     { response, stats: { inputTokens, outputTokens, durationMs } }
 *   - getPipeHelp — user-facing contract text
 */
import { describe, it, expect } from 'vitest'
import {
  buildPrompt,
  estimateTokens,
  formatPipeOutput,
  getPipeHelp,
} from '../src/integrations/pipeMode.js'

describe('pipeMode', () => {
  describe('buildPrompt', () => {
    it('builds prompt with stdin context and user prompt', () => {
      const result = buildPrompt('explain this', 'const x = 1', {
        cwd: '/test',
      })
      expect(result).toContain('Working directory: /test')
      expect(result).toContain('--- Input (from stdin) ---')
      expect(result).toContain('const x = 1')
      expect(result).toContain('--- End Input ---')
      expect(result).toContain('explain this')
    })

    it('includes project context by default', () => {
      const result = buildPrompt('test', 'content', { cwd: '/proj' })
      expect(result).toContain('Working directory: /proj')
    })

    it('skips project context when includeContext is false', () => {
      const result = buildPrompt('test', 'content', {
        cwd: '/proj',
        includeContext: false,
      })
      expect(result).not.toContain('Working directory:')
    })

    it('uses default prompt when stdin has content but no explicit prompt', () => {
      const result = buildPrompt(undefined, 'some code', { cwd: '/test' })
      expect(result).toContain('Analyze and respond')
    })

    it('throws when no prompt and no stdin', () => {
      expect(() => buildPrompt(undefined, '', { cwd: '/test' })).toThrow(
        'No prompt or stdin input',
      )
    })

    it('handles empty stdin with prompt', () => {
      const result = buildPrompt('hello', '', { cwd: '/test' })
      expect(result).toContain('hello')
      expect(result).not.toContain('--- Input (from stdin) ---')
    })

    it('truncates stdin longer than 1000 lines', () => {
      const longInput = Array(1500).fill('line').join('\n')
      const result = buildPrompt('summarize', longInput, { cwd: '/test' })
      expect(result).toContain('... (truncated)')
      // Should have ~1000 lines of content
      const lines = result.split('\n').filter((l) => l === 'line').length
      expect(lines).toBe(1000)
    })

    it('handles whitespace-only stdin as empty', () => {
      const result = buildPrompt('hello', '   \n\n  ', { cwd: '/test' })
      expect(result).toContain('hello')
      expect(result).not.toContain('--- Input (from stdin) ---')
    })
  })

  describe('estimateTokens', () => {
    it('estimates tokens as chars/4', () => {
      expect(estimateTokens('')).toBe(0)
      expect(estimateTokens('hello')).toBe(2) // ceil(5/4)
      expect(estimateTokens('hello world!')).toBe(3) // ceil(12/4)
    })

    it('handles unicode', () => {
      const tokens = estimateTokens('你好世界')
      expect(tokens).toBeGreaterThan(0)
    })
  })

  describe('formatPipeOutput — frozen sshRemote envelope', () => {
    const mockResult = {
      response: 'Hello world',
      stdinContent: 'input',
      fullPrompt: 'prompt',
      estimatedInputTokens: 10,
      estimatedOutputTokens: 5,
      durationMs: 100,
    }

    it('formats as text by default', () => {
      const out = formatPipeOutput(mockResult)
      expect(out).toBe('Hello world')
    })

    it('formats as text explicitly', () => {
      const out = formatPipeOutput(mockResult, 'text')
      expect(out).toBe('Hello world')
    })

    it('formats as json with stats', () => {
      const out = formatPipeOutput(mockResult, 'json')
      const parsed = JSON.parse(out)
      expect(parsed.response).toBe('Hello world')
      expect(parsed.stats.inputTokens).toBe(10)
      expect(parsed.stats.outputTokens).toBe(5)
      expect(parsed.stats.durationMs).toBe(100)
    })

    it('json output includes EXACTLY the frozen top-level and stats keys', () => {
      const out = formatPipeOutput(mockResult, 'json')
      const parsed = JSON.parse(out) as Record<string, unknown>
      expect(Object.keys(parsed).sort()).toEqual(['response', 'stats'])
      expect(Object.keys(parsed.stats as Record<string, unknown>).sort())
        .toEqual(['durationMs', 'inputTokens', 'outputTokens'])
    })

    it('handles multiline responses', () => {
      const out = formatPipeOutput(
        { ...mockResult, response: 'line1\nline2\nline3' },
        'text',
      )
      expect(out).toBe('line1\nline2\nline3')
    })
  })

  describe('getPipeHelp', () => {
    it('returns non-empty help text', () => {
      const help = getPipeHelp()
      expect(help).toBeTruthy()
      expect(help.length).toBeGreaterThan(100)
    })

    it('includes usage examples', () => {
      const help = getPipeHelp()
      expect(help).toContain('Usage:')
      expect(help).toContain('Examples:')
    })

    it('includes all options the real parser accepts', () => {
      const help = getPipeHelp()
      expect(help).toContain('--cwd')
      expect(help).toContain('--model')
      expect(help).toContain('--format')
      expect(help).toContain('--no-context')
      expect(help).toContain('--max-stdin')
      expect(help).toContain('--base-url')
    })

    it('documents the v0.4.1 exit ladder', () => {
      const help = getPipeHelp()
      expect(help).toContain('Exit codes:')
      expect(help).toContain('completed')
      expect(help).toContain('API error')
    })

    it('states the engine-backed stdout contract', () => {
      const help = getPipeHelp()
      expect(help).toContain('execution engine')
      expect(help).toContain('stdout')
      expect(help).toContain('--llm-only')
    })
  })
})
