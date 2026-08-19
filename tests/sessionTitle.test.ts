import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createSessionDir,
  saveSession,
  loadSessionEnvelope,
  setSessionTitle,
  MAX_SESSION_TITLE_LENGTH,
} from '../src/core/sessionManager.js'
import { deriveFallbackTitle, buildTitlePrompt, cleanGeneratedTitle } from '../src/core/sessionTitle.js'
import type { OpenAIMessage } from '../src/core/types.js'

let cwd = ''

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'ovogo-title-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

const HISTORY: OpenAIMessage[] = [
  { role: 'user', content: 'Fix the   login\nbug in auth.ts' },
  { role: 'assistant', content: 'Looking into it.' },
]

describe('sessionTitle helpers', () => {
  it('deriveFallbackTitle collapses whitespace and truncates', () => {
    expect(deriveFallbackTitle(HISTORY)).toBe('Fix the login bug in auth.ts')
  })

  it('deriveFallbackTitle returns empty without a user message', () => {
    expect(deriveFallbackTitle([{ role: 'assistant', content: 'hi' }])).toBe('')
  })

  it('buildTitlePrompt includes bounded transcript', () => {
    const prompt = buildTitlePrompt(HISTORY)
    expect(prompt).toContain('Fix the   login')
    expect(prompt).toContain('Looking into it.')
  })

  it('cleanGeneratedTitle strips quotes and Title: prefixes', () => {
    expect(cleanGeneratedTitle('"Login bug fix"')).toBe('Login bug fix')
    expect(cleanGeneratedTitle('Title: Login bug fix.')).toBe('Login bug fix.')
    expect(cleanGeneratedTitle('  `Auth refactor`  ')).toBe('Auth refactor')
  })
})

describe('session title persistence', () => {
  it('saveSession persists the title into the envelope', () => {
    const dir = createSessionDir(cwd)
    saveSession(dir, HISTORY, undefined, 'Auth bug hunt')
    const env = loadSessionEnvelope(dir)
    expect(env?.title).toBe('Auth bug hunt')
    expect(env?.messages).toHaveLength(2)
  })

  it('setSessionTitle updates an existing session without touching messages', () => {
    const dir = createSessionDir(cwd)
    saveSession(dir, HISTORY)
    expect(setSessionTitle(dir, 'New name')).toBe(true)
    const env = loadSessionEnvelope(dir)
    expect(env?.title).toBe('New name')
    expect(env?.messages).toEqual(HISTORY)
  })

  it('setSessionTitle returns false for a session without history', () => {
    const dir = createSessionDir(cwd)
    expect(setSessionTitle(dir, 'Nope')).toBe(false)
  })

  it('rejects empty and overlong titles', () => {
    const dir = createSessionDir(cwd)
    saveSession(dir, HISTORY)
    expect(() => setSessionTitle(dir, '   ')).toThrow()
    expect(() => setSessionTitle(dir, 'x'.repeat(MAX_SESSION_TITLE_LENGTH + 1))).toThrow()
  })

  it('drops malformed titles on load instead of rejecting the session', () => {
    const dir = createSessionDir(cwd)
    saveSession(dir, HISTORY, undefined, 'good title')
    // Corrupt the title field directly; the session must still load.
    const path = join(dir, 'history.json')
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    parsed.title = 42
    writeFileSync(path, JSON.stringify(parsed), 'utf8')
    const env = loadSessionEnvelope(dir)
    expect(env?.messages).toHaveLength(2)
    expect(env?.title).toBeUndefined()
  })
})
