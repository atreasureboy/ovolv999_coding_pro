import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadProjectSettings } from '../src/config/settings.js'

let cwd = ''

function writeSettings(obj: unknown): void {
  mkdirSync(join(cwd, '.ovogo'), { recursive: true })
  writeFileSync(join(cwd, '.ovogo', 'settings.json'), JSON.stringify(obj, null, 2), 'utf8')
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'ovogo-mcp-settings-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

describe('mcp settings normalization', () => {
  it('keeps stdio servers working', () => {
    writeSettings({
      mcp: {
        servers: [
          { name: 'fs', type: 'stdio', command: ['npx', '-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
        ],
      },
    })
    const s = loadProjectSettings(cwd)
    expect(s.mcp?.servers).toHaveLength(1)
    expect(s.mcp?.servers[0]).toMatchObject({ name: 'fs', type: 'stdio', command: ['npx', '-y', '@modelcontextprotocol/server-filesystem', '/tmp'] })
  })

  it('accepts http servers with url (previously force-coerced to stdio)', () => {
    writeSettings({
      mcp: { servers: [{ name: 'remote', type: 'http', url: 'https://mcp.example.com/v1' }] },
    })
    const s = loadProjectSettings(cwd)
    expect(s.mcp?.servers).toHaveLength(1)
    expect(s.mcp?.servers[0]).toEqual({ name: 'remote', type: 'http', url: 'https://mcp.example.com/v1' })
  })

  it('defaults type to stdio when omitted', () => {
    writeSettings({
      mcp: { servers: [{ name: 'fs', command: ['node', 'server.js'] }] },
    })
    const s = loadProjectSettings(cwd)
    expect(s.mcp?.servers[0]?.type).toBe('stdio')
  })

  it('carries static headers for http servers', () => {
    writeSettings({
      mcp: {
        servers: [{
          name: 'remote', type: 'http', url: 'https://mcp.example.com',
          headers: { 'x-api-key': 'abc', notAString: 42 },
        }],
      },
    })
    const s = loadProjectSettings(cwd)
    expect(s.mcp?.servers[0]?.headers).toEqual({ 'x-api-key': 'abc' })
  })

  it('validates oauth config and keeps only complete blocks', () => {
    writeSettings({
      mcp: {
        servers: [
          {
            name: 'oauth-ok', type: 'http', url: 'https://a.example.com',
            oauth: {
              authorizationEndpoint: 'https://a.example.com/auth',
              tokenEndpoint: 'https://a.example.com/token',
              clientId: 'cid',
              clientSecret: 'sec',
              scope: 'tools:read',
              redirectUri: 'http://localhost:33418/callback',
            },
          },
          {
            name: 'oauth-bad', type: 'http', url: 'https://b.example.com',
            oauth: { clientId: 'missing-the-rest' },
          },
        ],
      },
    })
    const s = loadProjectSettings(cwd)
    expect(s.mcp?.servers).toHaveLength(2)
    expect(s.mcp?.servers[0]?.oauth).toEqual({
      authorizationEndpoint: 'https://a.example.com/auth',
      tokenEndpoint: 'https://a.example.com/token',
      clientId: 'cid',
      clientSecret: 'sec',
      scope: 'tools:read',
      redirectUri: 'http://localhost:33418/callback',
    })
    expect(s.mcp?.servers[1]?.oauth).toBeUndefined()
  })

  it('drops http entries without a valid url', () => {
    writeSettings({
      mcp: {
        servers: [
          { name: 'nourle', type: 'http' },
          { name: 'badurl', type: 'http', url: 'not a url' },
          { name: 'ftp', type: 'http', url: 'ftp://example.com' },
        ],
      },
    })
    const s = loadProjectSettings(cwd)
    expect(s.mcp).toBeUndefined()
  })

  it('drops stdio entries without a command', () => {
    writeSettings({
      mcp: { servers: [{ name: 'nocmd', type: 'stdio' }] },
    })
    const s = loadProjectSettings(cwd)
    expect(s.mcp).toBeUndefined()
  })
})
