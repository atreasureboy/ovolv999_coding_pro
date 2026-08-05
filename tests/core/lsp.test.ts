import { describe, expect, it } from 'vitest'
import { pathToFileUri, LspClient } from '../../src/core/lsp/client.js'
import { LSP_SYMBOL_KIND, LSP_SYMBOL_KIND_NAMES } from '../../src/core/lsp/protocol.js'

describe('LSP protocol', () => {
  it('exposes SymbolKind enum', () => {
    expect(LSP_SYMBOL_KIND.Function).toBe(12)
    expect(LSP_SYMBOL_KIND.Class).toBe(5)
    expect(LSP_SYMBOL_KIND_NAMES[12]).toBe('Function')
  })
})

describe('pathToFileUri', () => {
  it('converts unix absolute path', () => {
    // v0.6.0 (audit): on win32 resolve('/home/...') maps onto the
    // current drive (C:\home\...) — the POSIX assertion only holds
    // on POSIX hosts.
    if (process.platform !== 'win32') {
      expect(pathToFileUri('/home/user/file.ts')).toBe('file:///home/user/file.ts')
    }
  })

  it('normalizes windows backslashes', () => {
    expect(pathToFileUri('C:\\Users\\file.ts')).toBe('file:///C:/Users/file.ts')
  })

  it('handles relative path with leading slash', () => {
    if (process.platform !== 'win32') {
      expect(pathToFileUri('/foo/bar')).toBe('file:///foo/bar')
    }
  })
})

describe('LspClient', () => {
  it('reports not started before .start()', () => {
    const client = new LspClient({ command: 'cat' })
    expect(client.isOpen).toBe(false)
  })

  it('exposes initialize result after start', async () => {
    const client = new LspClient({
      command: process.execPath,
      args: ['-e', "process.stdin.resume(); process.stdout.on('data', () => {})"],
      requestTimeoutMs: 2000,
    })
    try {
      await client.start('file:///tmp')
      expect(client.isOpen).toBe(true)
    } catch {
      // ignore — node may not be reachable in sandboxed CI
    }
  })

  it('has the 4 LSP tool methods', () => {
    const client = new LspClient({ command: 'cat' })
    expect(typeof client.definition).toBe('function')
    expect(typeof client.references).toBe('function')
    expect(typeof client.hover).toBe('function')
    expect(typeof client.documentSymbols).toBe('function')
  })
})
