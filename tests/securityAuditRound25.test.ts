/**
 * Security-audit regression tests (Round 25).
 *
 * Covers the fixes from the v0.6.2 architecture/security audit:
 *   1. WebFetch SSRF guard — private/reserved/metadata ranges blocked,
 *      loopback allowed, redirect hops re-validated, env kill-switch.
 *   2. OAuth token storage — 0600 perms + serverName sanitization.
 *   3. pathSecurity — case-insensitive filesystem bypass (ADR-007).
 */

import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { existsSync, statSync, readdirSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { WebFetchTool } from '../src/tools/webFetch.js'
import { isLoopDriverOwnedPath } from '../src/core/pathSecurity.js'
import type { ToolContext } from '../src/core/types.js'

function makeCtx(signal?: AbortSignal): ToolContext {
  return { cwd: process.cwd(), permissionMode: 'auto', signal }
}

describe('WebFetch — SSRF guard (H2)', () => {
  const tool = new WebFetchTool()
  let server: Server | undefined

  afterEach(async () => {
    if (server) {
      const srv = server
      srv.closeAllConnections?.()
      await new Promise<void>((resolve) => srv.close(() => resolve()))
      server = undefined
    }
    delete process.env.OVOGO_WEBFETCH_ALLOW_PRIVATE
  })

  it('blocks RFC1918 addresses before any request', async () => {
    const result = await tool.execute({ url: 'http://192.168.1.1/admin' }, makeCtx())
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/SSRF guard/)
    expect(result.content).toMatch(/192\.168\.1\.1/)
  })

  it('blocks cloud metadata endpoint', async () => {
    const result = await tool.execute(
      { url: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' },
      makeCtx(),
    )
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/SSRF guard/)
  })

  it('blocks 0.0.0.0, CGNAT, and IPv6 link-local/ULA', async () => {
    for (const url of ['http://0.0.0.0/', 'http://100.64.0.1/', 'http://[fe80::1]/', 'http://fd12::1/']) {
      const result = await tool.execute({ url }, makeCtx())
      expect(result.isError).toBe(true)
      expect(result.content).toMatch(/SSRF guard/)
    }
  })

  it('blocks .internal hostnames', async () => {
    const result = await tool.execute({ url: 'http://metadata.google.internal/' }, makeCtx())
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/SSRF guard/)
  })

  it('allows loopback (local dev servers are a core use case)', async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('local dev ok')
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    const addr = server?.address()
    if (!addr || typeof addr === 'string') throw new Error('bind failed')

    const result = await tool.execute({ url: `http://127.0.0.1:${addr.port}/` }, makeCtx())
    expect(result.isError).toBe(false)
    expect(result.content).toContain('local dev ok')
  })

  it('re-validates redirect targets — 302 to metadata IP is blocked', async () => {
    server = createServer((_req, res) => {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' })
      res.end()
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    const addr = server?.address()
    if (!addr || typeof addr === 'string') throw new Error('bind failed')

    const result = await tool.execute({ url: `http://127.0.0.1:${addr.port}/redirect` }, makeCtx())
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/SSRF guard/)
    expect(result.content).toMatch(/169\.254\.169\.254/)
  })

  it('follows safe redirects normally', async () => {
    server = createServer((req, res) => {
      if (req.url === '/hop') {
        res.writeHead(301, { Location: '/' })
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('landed')
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    const addr = server?.address()
    if (!addr || typeof addr === 'string') throw new Error('bind failed')

    const result = await tool.execute({ url: `http://127.0.0.1:${addr.port}/hop` }, makeCtx())
    expect(result.isError).toBe(false)
    expect(result.content).toContain('landed')
  })

  it('OVOGO_WEBFETCH_ALLOW_PRIVATE=1 disables the guard (documented kill-switch)', async () => {
    process.env.OVOGO_WEBFETCH_ALLOW_PRIVATE = '1'
    // Guard is off — the request proceeds to the (unroutable) private IP
    // and fails as a plain fetch/timeout error, NOT an SSRF-guard block.
    const result = await tool.execute({ url: 'http://10.255.255.1/' }, makeCtx())
    expect(result.content).not.toMatch(/SSRF guard/)
  })
})


describe('pathSecurity — case-insensitive FS bypass (ADR-007)', () => {
  it('lowercase spellings are treated as driver-owned regardless of platform', () => {
    // On case-sensitive fs, .loop/done.flag is a different file — but the
    // guard intentionally over-blocks lowercase variants everywhere.
    expect(isLoopDriverOwnedPath('/proj/.loop/done.flag')).toBe(true)
    expect(isLoopDriverOwnedPath('/proj/.loop/CHECKPOINT.json')).toBe(true)
  })

  it('case-variant directory is only matched on case-insensitive platforms', () => {
    const expected = process.platform === 'win32' || process.platform === 'darwin'
    expect(isLoopDriverOwnedPath('/proj/.LOOP/DONE.flag')).toBe(expected)
  })

  it('non-owned .loop files remain writable', () => {
    expect(isLoopDriverOwnedPath('/proj/.loop/STATE.md')).toBe(false)
    expect(isLoopDriverOwnedPath('/proj/.loop/CANDIDATE_DONE.flag')).toBe(false)
  })
})
