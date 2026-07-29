/**
 * v0.4.1 WS3 — parseArgs hardening.
 *
 * Before this change, unknown `--flags` were silently dropped while their
 * VALUES still leaked into the positional task text (`--pipe --wat watval
 * do x` ran the task "watval do x"). Now unknown dash-flags warn on stderr
 * and consume their value. The pipe-mode flags that the old parallel
 * parser (pipeMode.parsePipeArgs) understood — --max-stdin, --no-context,
 * --base-url — are first-class so one parser owns the whole CLI.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parseArgs } from '../bin/ovogogogo.js'

describe('parseArgs — pipe flags are first-class', () => {
  it('parses --max-stdin as a positive integer', () => {
    const args = parseArgs(['node', 'cli', '--pipe', '--max-stdin', '5000', 'task'])
    expect(args.maxStdinBytes).toBe(5000)
  })

  it('rejects non-numeric --max-stdin (exits via ArgError path)', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`)
    }) as never)
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      expect(() => parseArgs(['node', 'cli', '--pipe', '--max-stdin', 'abc', 'task'])).toThrow('exit:1')
    } finally {
      exitSpy.mockRestore()
      stderrSpy.mockRestore()
    }
  })

  it('parses --no-context', () => {
    const args = parseArgs(['node', 'cli', '--pipe', '--no-context', 'task'])
    expect(args.noContext).toBe(true)
  })

  it('parses --base-url', () => {
    const args = parseArgs(['node', 'cli', '--pipe', '--base-url', 'http://127.0.0.1:9999/v1', 'task'])
    expect(args.baseURL).toBe('http://127.0.0.1:9999/v1')
  })
})

describe('parseArgs — unknown flags no longer leak values into the task', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })
  afterEach(() => {
    stderrSpy.mockRestore()
  })

  it('unknown --flag + its value are both skipped; task stays clean', () => {
    const args = parseArgs(['node', 'cli', '--pipe', '--wat', 'watval', 'do', 'x'])
    expect(args.task).toBe('do x')
    const warned = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')
    expect(warned).toContain('--wat')
  })

  it('unknown single-dash flag is skipped with a warning (not silently)', () => {
    const args = parseArgs(['node', 'cli', '-Z', 'task'])
    expect(args.task).toBe('task')
    const warned = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')
    expect(warned).toContain('-Z')
  })

  it('unknown flag at end of argv warns without crashing', () => {
    const args = parseArgs(['node', 'cli', 'task', '--dangling'])
    expect(args.task).toBe('task')
    const warned = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')
    expect(warned).toContain('--dangling')
  })

  it('known flags still parse unchanged', () => {
    const args = parseArgs(['node', 'cli', '--model', 'm1', '--format', 'json', '--max-iter', '5', 'do it'])
    expect(args.model).toBe('m1')
    expect(args.pipeFormat).toBe('json')
    expect(args.maxIter).toBe(5)
    expect(args.task).toBe('do it')
  })

  it('no warning on a fully-known argv', () => {
    parseArgs(['node', 'cli', '--pipe', '--format', 'json', '--no-context', 'task'])
    expect(stderrSpy.mock.calls.length).toBe(0)
  })
})

describe('parseArgs — --profile (v0.4.1 WS4)', () => {
  it('parses a valid profile name', () => {
    const args = parseArgs(['node', 'cli', '--profile', 'fast', 'task'])
    expect(args.profile).toBe('fast')
    expect(args.task).toBe('task')
  })

  it('defaults to no override when absent', () => {
    const args = parseArgs(['node', 'cli', 'task'])
    expect(args.profile).toBeUndefined()
  })

  it('rejects an unknown profile (exit 1, never leaks into task text)', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`)
    }) as never)
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      expect(() => parseArgs(['node', 'cli', '--profile', 'turbo', 'task'])).toThrow('exit:1')
      const stderr = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')
      expect(stderr).toContain('--profile must be one of')
    } finally {
      exitSpy.mockRestore()
      stderrSpy.mockRestore()
    }
  })

  it('rejects a missing value (exit 1)', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`)
    }) as never)
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      expect(() => parseArgs(['node', 'cli', '--profile'])).toThrow('exit:1')
    } finally {
      exitSpy.mockRestore()
      stderrSpy.mockRestore()
    }
  })
})
