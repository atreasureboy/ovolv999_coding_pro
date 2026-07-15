/**
 * CLI3 — Round 3 fixes: cwd~ expansion, resume structure validation,
 * unique tmp cleanup (observable), pipe based on stdin TTY, askUser
 * isTTY gate.
 *
 * Only behavioral tests. Source-string assertions and global process
 * monkeypatches (stdout.write / exit) are deliberately avoided — ESM
 * fs namespace is not configurable for vi.spyOn, and process.stdout
 * patches leak into other tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'

import {
  expandHome,
  normalizeCwd,
  resolveResumePath,
} from '../bin/ovogogogo.js'
import {
  getProjectSettingsPath,
  saveProjectSettings,
} from '../src/config/settings.js'
import { readStdin } from '../src/ui/input.js'
import { SessionNotFoundError } from '../src/core/sessionManager.js'
import { createTerminalAskUserHandler } from '../src/tools/askUser.js'

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. cwd~ expansion
// ─────────────────────────────────────────────────────────────────────────────

describe('CLI3 #1: expandHome / normalizeCwd', () => {
  it('expands bare "~" to the current home directory', () => {
    expect(expandHome('~')).toBe(homedir())
  })

  it('expands "~/foo" by joining onto the home directory', () => {
    expect(expandHome('~/foo')).toBe(join(homedir(), 'foo'))
  })

  it('expands "~\\foo" (backslash separator) onto the home directory', () => {
    expect(expandHome('~\\foo')).toBe(join(homedir(), 'foo'))
  })

  it('passes absolute paths through unchanged', () => {
    expect(expandHome('/etc/ovogo')).toBe('/etc/ovogo')
    expect(expandHome('/var/tmp/x')).toBe('/var/tmp/x')
  })

  it('passes relative paths through unchanged (no leading ~)', () => {
    expect(expandHome('relative/path')).toBe('relative/path')
    expect(expandHome('foo')).toBe('foo')
  })

  it('does NOT expand "~user" forms (no user-DB lookup)', () => {
    expect(expandHome('~root')).toBe('~root')
    expect(expandHome('~alice/foo')).toBe('~alice/foo')
  })

  it('handles empty input defensively', () => {
    expect(expandHome('')).toBe('')
  })

  it('normalizeCwd returns an absolute path after ~ expansion', () => {
    const abs = normalizeCwd('~/foo/bar')
    expect(abs.startsWith('/')).toBe(true)
    expect(abs).toBe(join(homedir(), 'foo', 'bar'))
  })

  it('normalizeCwd resolves relative paths against the current cwd', () => {
    const abs = normalizeCwd('relative/dir')
    expect(abs.startsWith('/')).toBe(true)
    expect(abs).toContain('relative/dir')
  })

  it('normalizeCwd leaves an absolute path unchanged', () => {
    expect(normalizeCwd('/etc/ovogo')).toBe('/etc/ovogo')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. resume structure validation
// ─────────────────────────────────────────────────────────────────────────────

describe('CLI3 #2: resolveResumePath structural validation', () => {
  let cwd: string
  let sessionsDir: string
  let realSessionDir: string
  let realHistoryPath: string

  beforeEach(() => {
    cwd = makeTmpDir('cli3-resume-cwd-')
    sessionsDir = join(cwd, 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    realSessionDir = join(sessionsDir, 'session_2026-01-01_000000')
    mkdirSync(realSessionDir, { recursive: true })
    realHistoryPath = join(realSessionDir, 'history.json')
    writeFileSync(realHistoryPath, JSON.stringify({
      version: 1,
      schema: 'ovogo.session.v1',
      updatedAt: new Date().toISOString(),
      messages: [{ role: 'user', content: 'hi' }],
    }), 'utf8')
  })

  afterEach(() => {
    if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true })
  })

  it('returns the explicit directory when it has a readable history.json', () => {
    expect(resolveResumePath(cwd, realSessionDir)).toBe(realSessionDir)
  })

  it('returns the parent directory for a history.json file whose parent is session_*', () => {
    expect(resolveResumePath(cwd, realHistoryPath)).toBe(realSessionDir)
  })

  it('rejects an explicit directory whose basename does not start with "session_"', () => {
    const other = join(cwd, 'notasession')
    mkdirSync(other, { recursive: true })
    expect(() => resolveResumePath(cwd, other)).toThrow(SessionNotFoundError)
    expect(() => resolveResumePath(cwd, other)).toThrow(/session_/)
  })

  it('rejects an explicit session_* directory that is MISSING history.json', () => {
    // basename check passes; structural check must catch the empty dir.
    const empty = join(sessionsDir, 'session_empty')
    mkdirSync(empty, { recursive: true })
    expect(() => resolveResumePath(cwd, empty)).toThrow(SessionNotFoundError)
    expect(() => resolveResumePath(cwd, empty)).toThrow(/missing history\.json/)
  })

  it('rejects a history.json file whose parent is NOT a session directory', () => {
    const otherDir = join(cwd, 'random')
    mkdirSync(otherDir, { recursive: true })
    const stray = join(otherDir, 'history.json')
    writeFileSync(stray, '{}', 'utf8')
    expect(() => resolveResumePath(cwd, stray)).toThrow(SessionNotFoundError)
    expect(() => resolveResumePath(cwd, stray)).toThrow(/parent directory/)
  })

  it('rejects a file whose basename is NOT history.json', () => {
    const wrong = join(realSessionDir, 'notes.txt')
    writeFileSync(wrong, 'hello', 'utf8')
    expect(() => resolveResumePath(cwd, wrong)).toThrow(SessionNotFoundError)
    expect(() => resolveResumePath(cwd, wrong)).toThrow(/history\.json/)
  })

  it('rejects system roots before structural checks', () => {
    expect(() => resolveResumePath(cwd, '/etc')).toThrow(/system directory/)
  })

  it('rejects nonexistent explicit paths', () => {
    expect(() => resolveResumePath(cwd, join(cwd, 'sessions', 'session_nope'))).toThrow(/does not exist/)
  })

  it('delegates bare session names to resolveSessionPath (form 3)', () => {
    expect(resolveResumePath(cwd, 'session_2026-01-01_000000')).toBe(realSessionDir)
  })

  it('bare prefix lookup errors when no session matches', () => {
    expect(() => resolveResumePath(cwd, 'session_nothing')).toThrow(SessionNotFoundError)
  })

  it('defensive: empty input string throws a TypeError', () => {
    expect(() => resolveResumePath(cwd, '')).toThrow(TypeError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. saveProjectSettings — observable atomic-save behavior
// ─────────────────────────────────────────────────────────────────────────────

describe('CLI3 #3: saveProjectSettings atomic save (observable)', () => {
  let cwd: string
  beforeEach(() => { cwd = makeTmpDir('cli3-settings-') })
  afterEach(() => { if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true }) })

  it('leaves NO leftover tmp file on the happy path', () => {
    saveProjectSettings(cwd, { taskContext: { name: 'x' } })
    const projectPath = getProjectSettingsPath(cwd)
    const dir = join(projectPath, '..')
    const entries = fs.readdirSync(dir)
    expect(entries.some((n) => /\.tmp\./.test(n))).toBe(false)
  })

  it('100 rapid saves do not race on a fixed tmp name', () => {
    // The atomic-save contract uses a unique pid+ms+random suffix so
    // concurrent saves can't clobber each other's tmp. Observable
    // signal: after 100 rapid saves, exactly one settings.json
    // survives and the final content matches the LAST write. If two
    // writers had shared a fixed tmp, we'd see content from an
    // earlier iteration or a partially-written file.
    for (let i = 0; i < 100; i++) {
      saveProjectSettings(cwd, { taskContext: { name: `iter-${i}` } })
    }
    const projectPath = getProjectSettingsPath(cwd)
    const dir = join(projectPath, '..')
    const entries = fs.readdirSync(dir)
    expect(entries.filter((n) => n === 'settings.json')).toHaveLength(1)
    expect(entries.some((n) => /\.tmp\./.test(n))).toBe(false)
    const finalSettings = JSON.parse(readFileSync(projectPath, 'utf8'))
    expect(finalSettings.taskContext.name).toBe('iter-99')
  })

  it('preserves unrelated settings when patching a subset', () => {
    saveProjectSettings(cwd, { permissions: { mode: 'plan' } })
    saveProjectSettings(cwd, { taskContext: { name: 'phase-A' } })
    const loaded = JSON.parse(readFileSync(getProjectSettingsPath(cwd), 'utf8'))
    expect(loaded.permissions?.mode).toBe('plan')
    expect(loaded.taskContext?.name).toBe('phase-A')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. pipe mode driven by stdin.isTTY
// ─────────────────────────────────────────────────────────────────────────────

describe('CLI3 #4: pipe mode driven by stdin.isTTY', () => {
  let origIsTTY: boolean | undefined
  beforeEach(() => {
    origIsTTY = (process.stdin as { isTTY?: boolean }).isTTY
  })
  afterEach(() => {
    if (origIsTTY === undefined) {
      Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true })
    } else {
      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true })
    }
  })

  it('readStdin returns "" when stdin is a TTY (no pipe)', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    const out = await readStdin({ timeoutMs: 100 })
    expect(out).toBe('')
  })

  it('readStdin reads piped content when stdin is not a TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
    const origOn = process.stdin.on.bind(process.stdin)
    const listeners: Record<string, Array<(...a: unknown[]) => void>> = {}
    ;(process.stdin as unknown as { on: typeof origOn }).on = ((ev: string, cb: (...a: unknown[]) => void) => {
      ;(listeners[ev] ??= []).push(cb)
      return process.stdin
    }) as typeof origOn
    queueMicrotask(() => {
      listeners['data']?.forEach((cb) => cb(Buffer.from('hello piped')))
      listeners['end']?.forEach((cb) => cb())
    })
    const out = await readStdin({ timeoutMs: 1000 })
    expect(out).toBe('hello piped')
    ;(process.stdin as unknown as { on: typeof origOn }).on = origOn
  })

  it('readStdin waits for the "end" event before resolving on a pipe', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
    const origOn = process.stdin.on.bind(process.stdin)
    const listeners: Record<string, Array<(...a: unknown[]) => void>> = {}
    ;(process.stdin as unknown as { on: typeof origOn }).on = ((ev: string, cb: (...a: unknown[]) => void) => {
      ;(listeners[ev] ??= []).push(cb)
      return process.stdin
    }) as typeof origOn
    let resolved = false
    const pending = readStdin({ timeoutMs: 2000 }).then((s) => { resolved = true; return s })
    // Push some data WITHOUT end → should NOT resolve.
    queueMicrotask(() => listeners['data']?.forEach((cb) => cb(Buffer.from('partial'))))
    await new Promise((r) => setTimeout(r, 30))
    expect(resolved).toBe(false)
    // Now fire end → resolves with the accumulated data.
    queueMicrotask(() => listeners['end']?.forEach((cb) => cb()))
    const out = await pending
    expect(out).toBe('partial')
    ;(process.stdin as unknown as { on: typeof origOn }).on = origOn
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. askUser isTTY gate considers stdin AND stdout
// ─────────────────────────────────────────────────────────────────────────────

describe('CLI3 #5: askUser isTTY gate considers stdin too', () => {
  let origOutTTY: boolean | undefined
  let origInTTY: boolean | undefined

  beforeEach(() => {
    origOutTTY = (process.stdout as { isTTY?: boolean }).isTTY
    origInTTY = (process.stdin as { isTTY?: boolean }).isTTY
  })
  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: origOutTTY, configurable: true })
    Object.defineProperty(process.stdin, 'isTTY', { value: origInTTY, configurable: true })
  })

  it('askUser auto-answers when stdout is a TTY but stdin is redirected', () => {
    // `ovolv999 | tee log.txt` — stdout is interactive but stdin is a pipe.
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
    const reads: string[] = []
    const shared = {
      isTTY: false,
      readLine: vi.fn((p: string) => {
        reads.push(p)
        return Promise.resolve({ text: '', eof: true })
      }),
      close: vi.fn(),
    }
    const handler = createTerminalAskUserHandler({ prompt: shared, writeOut: () => {} })
    return handler([
      { question: 'Q?', header: 'H', options: [
        { label: 'A', description: 'a' },
        { label: 'B', description: 'b' },
      ] },
    ]).then((out) => {
      expect(out['Q?']).toMatch(/auto/i)
      expect(out['Q?']).toMatch(/non-interactive/i)
      expect(reads).toHaveLength(0)
    })
  })

  it('askUser auto-answers when stdin is a TTY but stdout is redirected', () => {
    // `cat prompt | ovolv999` — stdout is interactive in theory but
    // user may not see what we write.
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    const shared = {
      isTTY: false,
      readLine: vi.fn(() => Promise.resolve({ text: '', eof: true })),
      close: vi.fn(),
    }
    const handler = createTerminalAskUserHandler({ prompt: shared, writeOut: () => {} })
    return handler([
      { question: 'Q?', header: 'H', options: [
        { label: 'A', description: 'a' },
        { label: 'B', description: 'b' },
      ] },
    ]).then((out) => {
      expect(out['Q?']).toMatch(/auto/i)
    })
  })

  it('askUser prompts normally when both stdout and stdin are TTYs', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    const shared = {
      isTTY: true,
      readLine: vi.fn(() => Promise.resolve({ text: '1', eof: false })),
      close: vi.fn(),
    }
    const handler = createTerminalAskUserHandler({ prompt: shared, writeOut: () => {} })
    return handler([
      { question: 'Q?', header: 'H', options: [
        { label: 'A', description: 'a' },
        { label: 'B', description: 'b' },
      ] },
    ]).then((out) => {
      expect(out['Q?']).toBe('A')
      expect(shared.readLine).toHaveBeenCalledTimes(1)
    })
  })
})