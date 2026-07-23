import { describe, it, expect, beforeEach } from 'vitest'
import {
  matchHook,
  validateHooksConfig,
  formatHooksConfig,
  formatHookResult,
  runHook,
  type HookConfig,
  type HooksConfig,
  type HookContext,
} from '../src/core/hooks.js'

describe('hooks', () => {
  describe('matchHook', () => {
    it('matches * (all)', () => {
      expect(matchHook('*', 'Bash')).toBe(true)
      expect(matchHook('*', 'Read')).toBe(true)
    })

    it('matches empty string as all', () => {
      expect(matchHook('', 'Bash')).toBe(true)
    })

    it('matches exact tool name', () => {
      expect(matchHook('Bash', 'Bash')).toBe(true)
      expect(matchHook('Bash', 'Read')).toBe(false)
    })

    it('matches alternation', () => {
      expect(matchHook('Bash|Read', 'Bash')).toBe(true)
      expect(matchHook('Bash|Read', 'Read')).toBe(true)
      expect(matchHook('Bash|Read', 'Write')).toBe(false)
    })

    it('matches Tool(inputPattern) with command', () => {
      expect(matchHook('Bash(git *)', 'Bash', { command: 'git status' })).toBe(true)
      expect(matchHook('Bash(git *)', 'Bash', { command: 'ls' })).toBe(false)
    })

    it('matches Tool(inputPattern) with path', () => {
      expect(matchHook('Write(*.env*)', 'Write', { filePath: '.env' })).toBe(true)
      expect(matchHook('Write(*.env*)', 'Write', { filePath: 'src.ts' })).toBe(false)
    })

    it('matches Tool() with empty pattern (any input)', () => {
      expect(matchHook('Bash()', 'Bash', { command: 'anything' })).toBe(true)
    })

    it('does not match wrong tool name in pattern', () => {
      expect(matchHook('Bash(git *)', 'Read', { command: 'git status' })).toBe(false)
    })
  })

  describe('validateHooksConfig', () => {
    it('returns empty for invalid input', () => {
      expect(validateHooksConfig(null)).toEqual({})
      expect(validateHooksConfig('string')).toEqual({})
      expect(validateHooksConfig(42)).toEqual({})
    })

    it('validates a proper config', () => {
      const config = validateHooksConfig({
        PreToolUse: [
          { matcher: 'Bash', command: 'echo pre' },
          { matcher: 'Write', command: 'echo write', timeout: 5000 },
        ],
        PostToolUse: [
          { matcher: '*', command: 'echo post' },
        ],
      })
      expect(config.PreToolUse).toHaveLength(2)
      expect(config.PreToolUse?.[0].matcher).toBe('Bash')
      expect(config.PreToolUse?.[1].timeout).toBe(5000)
      expect(config.PostToolUse).toHaveLength(1)
    })

    it('filters invalid hooks', () => {
      const config = validateHooksConfig({
        PreToolUse: [
          { matcher: 'Bash', command: 'echo ok' },
          { matcher: 'Bad' }, // missing command
          'not an object',
          { command: 'no matcher' }, // defaults to '*'
        ],
      })
      expect(config.PreToolUse).toHaveLength(2)
      expect(config.PreToolUse?.[1].matcher).toBe('*')
    })

    it('ignores unknown events', () => {
      const config = validateHooksConfig({
        UnknownEvent: [{ matcher: '*', command: 'echo' }],
      })
      expect((config as Record<string, unknown>).UnknownEvent).toBeUndefined()
    })
  })

  describe('formatHooksConfig', () => {
    it('shows empty message for no hooks', () => {
      expect(formatHooksConfig({})).toContain('No hooks')
    })

    it('lists configured hooks', () => {
      const config: HooksConfig = {
        PreToolUse: [{ matcher: 'Bash', command: 'echo pre' }],
      }
      const out = formatHooksConfig(config)
      expect(out).toContain('PreToolUse')
      expect(out).toContain('Bash')
      expect(out).toContain('echo pre')
    })

    it('shows timeout when set', () => {
      const config: HooksConfig = {
        PostToolUse: [{ matcher: '*', command: 'echo post', timeout: 10000 }],
      }
      const out = formatHooksConfig(config)
      expect(out).toContain('10000ms')
    })
  })

  describe('runHook', () => {
    const ctx: HookContext = {
      event: 'PreToolUse',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      cwd: process.cwd(),
    }

    it('runs a successful hook', () => {
      const hook: HookConfig = { matcher: '*', command: 'echo hello' }
      const result = runHook(hook, ctx)
      expect(result.success).toBe(true)
      expect(result.allowed).toBe(true)
      expect(result.stdout.trim()).toBe('hello')
      expect(result.exitCode).toBe(0)
    })

    it('blocks on exit code 2', () => {
      const hook: HookConfig = {
        matcher: '*',
        command: 'echo "blocked" 1>&2 && exit 2',
      }
      const result = runHook(hook, ctx)
      expect(result.success).toBe(false)
      expect(result.allowed).toBe(false)
      expect(result.exitCode).toBe(2)
      expect(result.blockReason).toBeTruthy()
    })

    it('captures stderr on failure', () => {
      const hook: HookConfig = {
        matcher: '*',
        command: 'echo errormsg 1>&2 && exit 1',
      }
      const result = runHook(hook, ctx)
      expect(result.success).toBe(false)
      expect(result.allowed).toBe(true) // exit 1 doesn't block
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('errormsg')
    })

    it('handles command not found', () => {
      const hook: HookConfig = { matcher: '*', command: 'this-command-does-not-exist-xyz' }
      const result = runHook(hook, ctx)
      expect(result.success).toBe(false)
    })

    it('passes env vars to hook', () => {
      const hook: HookConfig = { matcher: '*', command: 'echo $TOOL_NAME' }
      const result = runHook(hook, ctx)
      expect(result.stdout.trim()).toBe('Bash')
    })

    it('passes tool input fields as env vars', () => {
      const hook: HookConfig = { matcher: '*', command: 'echo $TOOL_INPUT_COMMAND' }
      const result = runHook(hook, { ...ctx, toolInput: { command: 'git status' } })
      expect(result.stdout.trim()).toBe('git status')
    })
  })

  describe('formatHookResult', () => {
    it('renders allowed result', () => {
      const result = runHook({ matcher: '*', command: 'echo ok' }, {
        event: 'PreToolUse',
        cwd: process.cwd(),
      })
      const out = formatHookResult(result)
      expect(out).toContain('✓')
    })

    it('renders blocked result', () => {
      const result = runHook({
        matcher: '*',
        command: 'exit 2',
      }, {
        event: 'PreToolUse',
        cwd: process.cwd(),
      })
      const out = formatHookResult(result)
      expect(out).toContain('BLOCKED')
    })
  })
})
