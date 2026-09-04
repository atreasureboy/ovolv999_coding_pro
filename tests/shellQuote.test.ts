import { describe, it, expect } from 'vitest'
import { execSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { shellQuote } from '../src/utils/shellQuote.js'

describe('shellQuote', () => {
  it('passes safe tokens through unquoted', () => {
    expect(shellQuote('origin')).toBe('origin')
    expect(shellQuote('main')).toBe('main')
    expect(shellQuote('/usr/local/bin')).toBe('/usr/local/bin')
    expect(shellQuote('user@host:path')).toBe('user@host:path')
    expect(shellQuote('a=b')).toBe('a=b')
  })

  it('quotes the empty string', () => {
    expect(shellQuote('')).toBe("''")
  })

  it('neutralizes single quotes via the escape idiom', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
    expect(shellQuote("'; rm -rf /;")).toBe(`''\\''; rm -rf /;'`)
  })

  it('round-trips hostile arguments through a real shell unexpanded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ovolv999-shellquote-'))
    try {
      const marker = join(dir, 'pwned')
      const hostile = `$(touch ${marker})`
      const out = execSync(`printf '%s' ${shellQuote(hostile)}`, { encoding: 'utf8', shell: '/bin/sh' })
      expect(out).toBe(hostile)
      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never lets a backtick payload execute', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ovolv999-shellquote-'))
    try {
      const marker = join(dir, 'pwned2')
      writeFileSync(marker, 'x')
      const hostile = '`rm ' + marker + '`'
      const out = execSync(`printf '%s' ${shellQuote(hostile)}`, { encoding: 'utf8', shell: '/bin/sh' })
      expect(out).toBe(hostile)
      expect(existsSync(marker)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
