import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { stripJsonc, parseJsonc } from '../src/utils/jsonc.js'
import { loadProjectSettings } from '../src/config/settings.js'
import { loadProjectConfig } from '../src/config/projectConfig.js'

describe('stripJsonc', () => {
  it('removes line comments', () => {
    expect(JSON.parse(stripJsonc('{\n// comment\n"a": 1\n}'))).toEqual({ a: 1 })
  })

  it('removes block comments across lines', () => {
    expect(JSON.parse(stripJsonc('{\n/* one\ntwo */\n"a": 1\n}'))).toEqual({ a: 1 })
  })

  it('removes trailing commas', () => {
    expect(JSON.parse(stripJsonc('{"a": [1, 2, ], "b": {"c": 3, },}'))).toEqual({ a: [1, 2], b: { c: 3 } })
  })

  it('preserves comment markers inside strings', () => {
    const out = stripJsonc('{"url": "https://example.com/v1", "note": "a /* kept */ b"}')
    expect(JSON.parse(out)).toEqual({ url: 'https://example.com/v1', note: 'a /* kept */ b' })
  })

  it('preserves escaped quotes inside strings', () => {
    const out = stripJsonc('{"s": "he said \\"hi\\" // not a comment"}')
    expect(JSON.parse(out)).toEqual({ s: 'he said "hi" // not a comment' })
  })

  it('throws on unterminated block comment', () => {
    expect(() => stripJsonc('{ "a": 1 /* nope')).toThrow(/block comment/)
  })

  it('plain JSON passes through untouched', () => {
    expect(stripJsonc('{"a":1}')).toBe('{"a":1}')
  })
})

describe('parseJsonc', () => {
  it('parses plain JSON on the fast path', () => {
    expect(parseJsonc('{"a": 1}')).toEqual({ a: 1 })
  })

  it('parses JSONC with comments and trailing commas', () => {
    const text = `{
      // provider
      "provider": "openai",
      /* model block */
      "model": "x",
    }`
    expect(parseJsonc(text)).toEqual({ provider: 'openai', model: 'x' })
  })

  it('throws the original syntax error for genuinely broken input', () => {
    expect(() => parseJsonc('{"a": ')).toThrow()
  })
})

describe('settings integration', () => {
  let cwd = ''
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'ovogo-jsonc-'))
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it('loadProjectSettings accepts commented settings.json', () => {
    mkdirSync(join(cwd, '.ovogo'), { recursive: true })
    writeFileSync(join(cwd, '.ovogo', 'settings.json'), `{
      // MCP servers for this project
      "mcp": {
        "servers": [
          { "name": "fs", "command": ["node", "srv.js"] }, // trailing comma below
        ],
      },
    }`, 'utf8')
    const s = loadProjectSettings(cwd)
    expect(s.mcp?.servers).toHaveLength(1)
    expect(s.mcp?.servers[0].name).toBe('fs')
  })

  it('loadProjectConfig no longer corrupts URLs in strings', () => {
    writeFileSync(join(cwd, '.ovolv999.json'), JSON.stringify({
      systemPrompt: 'see https://example.com for docs',
    }), 'utf8')
    const cfg = loadProjectConfig(cwd)
    expect(cfg?.systemPrompt).toBe('see https://example.com for docs')
  })

  it('loadProjectConfig accepts comments in .ovolv999.json', () => {
    writeFileSync(join(cwd, '.ovolv999.json'), `{
      // custom prompt
      "systemPrompt": "be brief",
    }`, 'utf8')
    const cfg = loadProjectConfig(cwd)
    expect(cfg?.systemPrompt).toBe('be brief')
  })
})
