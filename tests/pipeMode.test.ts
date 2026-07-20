import { describe, it, expect } from 'vitest'
import {
  buildPrompt,
  gatherProjectContext,
  estimateTokens,
  executePipe,
  formatPipeOutput,
  parsePipeArgs,
  getPipeHelp,
  type PipeOptions,
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

  describe('gatherProjectContext', () => {
    it('returns git branch in a git repo', () => {
      const ctx = gatherProjectContext(process.cwd())
      // This project IS a git repo
      expect(ctx).toContain('Git branch:')
    })

    it('handles non-existent directory gracefully', () => {
      const ctx = gatherProjectContext('/nonexistent/path')
      // Should not throw, may be empty or just have what it can find
      expect(typeof ctx).toBe('string')
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

  describe('executePipe', () => {
    it('calls LLM with full prompt and returns result', async () => {
      const mockLLM = async (prompt: string) => `Response to: ${prompt.slice(0, 20)}`

      const result = await executePipe(
        { cwd: '/test', prompt: 'hello' },
        'stdin content',
        mockLLM,
      )

      expect(result.response).toContain('Response to:')
      expect(result.stdinContent).toBe('stdin content')
      expect(result.fullPrompt).toContain('hello')
      expect(result.estimatedInputTokens).toBeGreaterThan(0)
      expect(result.estimatedOutputTokens).toBeGreaterThan(0)
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('propagates LLM errors', async () => {
      const failingLLM = async () => {
        throw new Error('API failure')
      }

      await expect(
        executePipe({ cwd: '/test' }, 'content', failingLLM),
      ).rejects.toThrow('API failure')
    })

    it('passes options to LLM call', async () => {
      let receivedOpts: PipeOptions | null = null
      const mockLLM = async (_prompt: string, opts: PipeOptions) => {
        receivedOpts = opts
        return 'ok'
      }

      await executePipe(
        { cwd: '/test', model: 'gpt-4o-mini', format: 'json' },
        'content',
        mockLLM,
      )

      expect(receivedOpts).not.toBeNull()
      expect(receivedOpts!.model).toBe('gpt-4o-mini')
      expect(receivedOpts!.format).toBe('json')
    })
  })

  describe('formatPipeOutput', () => {
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

    it('json output includes stats object', () => {
      const out = formatPipeOutput(mockResult, 'json')
      const parsed = JSON.parse(out)
      expect(parsed).toHaveProperty('response')
      expect(parsed).toHaveProperty('stats')
      expect(parsed.stats).toHaveProperty('inputTokens')
      expect(parsed.stats).toHaveProperty('outputTokens')
      expect(parsed.stats).toHaveProperty('durationMs')
    })

    it('handles multiline responses', () => {
      const out = formatPipeOutput(
        { ...mockResult, response: 'line1\nline2\nline3' },
        'text',
      )
      expect(out).toBe('line1\nline2\nline3')
    })
  })

  describe('parsePipeArgs', () => {
    it('returns null for --help', () => {
      expect(parsePipeArgs(['--help'])).toBeNull()
      expect(parsePipeArgs(['-h'])).toBeNull()
    })

    it('parses prompt from positional args', () => {
      const result = parsePipeArgs(['explain', 'this', 'code'])
      expect(result).not.toBeNull()
      expect(result!.prompt).toBe('explain this code')
    })

    it('parses --cwd', () => {
      const result = parsePipeArgs(['--cwd', '/custom', 'prompt'])
      expect(result!.cwd).toBe('/custom')
    })

    it('parses -C as cwd alias', () => {
      const result = parsePipeArgs(['-C', '/custom', 'prompt'])
      expect(result!.cwd).toBe('/custom')
    })

    it('parses --model', () => {
      const result = parsePipeArgs(['--model', 'gpt-4o-mini', 'prompt'])
      expect(result!.model).toBe('gpt-4o-mini')
    })

    it('parses -m as model alias', () => {
      const result = parsePipeArgs(['-m', 'claude-3', 'prompt'])
      expect(result!.model).toBe('claude-3')
    })

    it('parses --format json', () => {
      const result = parsePipeArgs(['--format', 'json', 'prompt'])
      expect(result!.format).toBe('json')
    })

    it('parses --no-context', () => {
      const result = parsePipeArgs(['--no-context', 'prompt'])
      expect(result!.includeContext).toBe(false)
    })

    it('parses --max-stdin', () => {
      const result = parsePipeArgs(['--max-stdin', '5000', 'prompt'])
      expect(result!.maxStdinBytes).toBe(5000)
    })

    it('parses --base-url', () => {
      const result = parsePipeArgs(['--base-url', 'http://localhost:8080', 'prompt'])
      expect(result!.baseURL).toBe('http://localhost:8080')
    })

    it('defaults cwd to process.cwd()', () => {
      const result = parsePipeArgs(['prompt'])
      expect(result!.cwd).toBe(process.cwd())
    })

    it('handles no args', () => {
      const result = parsePipeArgs([])
      expect(result).not.toBeNull()
      expect(result!.prompt).toBeUndefined()
    })

    it('handles mixed args', () => {
      const result = parsePipeArgs([
        '--model', 'gpt-4o',
        'explain',
        '--format', 'json',
        'this code',
      ])
      expect(result!.model).toBe('gpt-4o')
      expect(result!.format).toBe('json')
      expect(result!.prompt).toBe('explain this code')
    })

    it('skips unknown flags', () => {
      const result = parsePipeArgs(['--unknown', 'value', 'prompt'])
      expect(result).not.toBeNull()
      // Unknown flag consumed 'value', but 'prompt' should still be captured
      expect(result!.prompt).toContain('prompt')
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

    it('includes all options', () => {
      const help = getPipeHelp()
      expect(help).toContain('--cwd')
      expect(help).toContain('--model')
      expect(help).toContain('--format')
      expect(help).toContain('--no-context')
      expect(help).toContain('--max-stdin')
      expect(help).toContain('--base-url')
    })

    it('includes exit codes', () => {
      const help = getPipeHelp()
      expect(help).toContain('Exit codes:')
      expect(help).toContain('success')
      expect(help).toContain('error')
      expect(help).toContain('API error')
    })
  })
})
