import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  generatePkcePair,
  buildAuthorizationUrl,
  exchangeCodeForToken,
  refreshToken,
  loadTokenStore,
  saveTokenStore,
  getValidToken,
  deleteToken,
  storeToken,
  type OAuthConfig,
  type OAuthTokenSet,
} from '../../src/integrations/mcpOAuth.js'

const FAKE_CONFIG: OAuthConfig = {
  serverId: 'test-server',
  authorizationEndpoint: 'https://auth.example.com/authorize',
  tokenEndpoint: 'https://auth.example.com/token',
  clientId: 'client-123',
  clientSecret: 'secret-abc',
  redirectUri: 'http://127.0.0.1:12345/callback',
  scope: 'read:foo write:foo',
}

function mockFetch(response: { ok: boolean; status?: number; body: unknown }): typeof fetch {
  const fn = (async () => new Response(
    typeof response.body === 'string' ? response.body : JSON.stringify(response.body),
    { status: response.status ?? (response.ok ? 200 : 400), headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch
  return fn
}

describe('PKCE', () => {
  it('generates a unique verifier/challenge/state pair', () => {
    const a = generatePkcePair()
    const b = generatePkcePair()
    expect(a.codeVerifier).not.toBe(b.codeVerifier)
    expect(a.codeChallenge).not.toBe(b.codeChallenge)
    expect(a.state).not.toBe(b.state)
    expect(a.codeVerifier.length).toBeGreaterThan(40)
    expect(a.codeChallenge.length).toBeGreaterThan(40)
  })

  it('builds an authorization URL with all PKCE parameters', () => {
    const url = buildAuthorizationUrl(FAKE_CONFIG, generatePkcePair())
    const parsed = new URL(url)
    expect(parsed.searchParams.get('response_type')).toBe('code')
    expect(parsed.searchParams.get('client_id')).toBe('client-123')
    expect(parsed.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:12345/callback')
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256')
    expect(parsed.searchParams.get('code_challenge')?.length).toBeGreaterThan(40)
    expect(parsed.searchParams.get('state')?.length).toBeGreaterThan(20)
    expect(parsed.searchParams.get('scope')).toBe('read:foo write:foo')
  })
})

describe('Token exchange', () => {
  it('exchanges authorization code for tokens', async () => {
    const tokens = await exchangeCodeForToken(
      FAKE_CONFIG,
      'auth-code-xyz',
      generatePkcePair(),
      mockFetch({
        ok: true,
        body: {
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 3600,
          scope: 'read:foo',
          token_type: 'Bearer',
        },
      }),
    )
    expect(tokens.accessToken).toBe('access-1')
    expect(tokens.refreshToken).toBe('refresh-1')
    expect(tokens.expiresAt).toBeGreaterThan(Date.now())
    expect(tokens.scope).toBe('read:foo')
    expect(tokens.serverId).toBe('test-server')
  })

  it('throws on non-200 response', async () => {
    await expect(
      exchangeCodeForToken(FAKE_CONFIG, 'auth-code', generatePkcePair(), mockFetch({ ok: false, status: 400, body: { error: 'invalid_grant' } })),
    ).rejects.toThrow(/OAuth token exchange failed/)
  })
})

describe('Token refresh', () => {
  it('refreshes an existing token', async () => {
    const tokens = await refreshToken(FAKE_CONFIG, 'old-refresh', mockFetch({
      ok: true,
      body: { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 7200 },
    }))
    expect(tokens.accessToken).toBe('access-2')
    expect(tokens.refreshToken).toBe('refresh-2')
  })
})

describe('Token store', () => {
  let dir: string
  let oldHome: string | undefined
  let oldUserProfile: string | undefined
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-oauth-'))
    oldHome = process.env.HOME
    oldUserProfile = process.env.USERPROFILE
    // os.homedir() reads HOME on POSIX but USERPROFILE on win32 — set both.
    process.env.HOME = dir
    process.env.USERPROFILE = dir
  })
  afterEach(() => {
    process.env.HOME = oldHome
    if (oldUserProfile !== undefined) process.env.USERPROFILE = oldUserProfile
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips tokens via storeToken → loadTokenStore', () => {
    const token: OAuthTokenSet = {
      serverId: 'srv',
      accessToken: 'at',
      refreshToken: 'rt',
      acquiredAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
    }
    storeToken(token)
    const store = loadTokenStore()
    expect(store.get('srv')?.accessToken).toBe('at')
  })

  it('deleteToken removes the entry', () => {
    storeToken({ serverId: 'srv', accessToken: 'at', acquiredAt: Date.now() })
    expect(deleteToken('srv')).toBe(true)
    expect(loadTokenStore().has('srv')).toBe(false)
  })

  it('saveTokenStore overwrites existing', () => {
    saveTokenStore(new Map([['a', { serverId: 'a', accessToken: 'first', acquiredAt: 1 }]]))
    saveTokenStore(new Map([['a', { serverId: 'a', accessToken: 'second', acquiredAt: 2 }]]))
    expect(loadTokenStore().get('a')?.accessToken).toBe('second')
  })

  it('returns empty map when store does not exist', () => {
    expect(loadTokenStore().size).toBe(0)
  })

  it('preserves a corrupt token store before resetting', () => {
    const path = join(dir, '.ovogo', 'mcp-tokens.json')
    const backup = `${path}.corrupt`
    mkdirSync(join(dir, '.ovogo'), { recursive: true })
    writeFileSync(path, '{"tokens": [torn', 'utf8')

    expect(loadTokenStore().size).toBe(0)
    expect(readFileSync(backup, 'utf8')).toBe('{"tokens": [torn')

    // The store is usable again afterwards and the forensic backup survives.
    saveTokenStore(new Map([['a', { serverId: 'a', accessToken: 'at', acquiredAt: 1 }]]))
    expect(loadTokenStore().get('a')?.accessToken).toBe('at')
    expect(readFileSync(backup, 'utf8')).toBe('{"tokens": [torn')
  })

  it('drops a malformed token entry without nuking the well-formed ones', () => {
    const path = join(dir, '.ovogo', 'mcp-tokens.json')
    mkdirSync(join(dir, '.ovogo'), { recursive: true })
    writeFileSync(path, JSON.stringify({
      tokens: [
        { serverId: 'good', accessToken: 'ok', acquiredAt: 1 },
        { broken: true },
        'garbage',
      ],
    }), 'utf8')

    const store = loadTokenStore()
    expect(store.has('good')).toBe(true)
    expect(store.size).toBe(1)
  })
})

describe('getValidToken', () => {
  let dir: string
  let oldHome: string | undefined
  let oldUserProfile: string | undefined
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-oauth-'))
    oldHome = process.env.HOME
    oldUserProfile = process.env.USERPROFILE
    process.env.HOME = dir
    process.env.USERPROFILE = dir
  })
  afterEach(() => {
    process.env.HOME = oldHome
    if (oldUserProfile !== undefined) process.env.USERPROFILE = oldUserProfile
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the cached token when not expired', async () => {
    storeToken({
      serverId: 'srv',
      accessToken: 'cached',
      acquiredAt: Date.now(),
      expiresAt: Date.now() + 10 * 60_000,
    })
    const fetchedToken = await getValidToken('srv', FAKE_CONFIG)
    expect(fetchedToken).toBe('cached')
  })

  it('refreshes when token is about to expire', async () => {
    storeToken({
      serverId: 'srv',
      accessToken: 'old',
      refreshToken: 'refresh-1',
      acquiredAt: Date.now(),
      expiresAt: Date.now() + 30_000,
    })
    const token = await getValidToken('srv', FAKE_CONFIG, mockFetch({
      ok: true,
      body: { access_token: 'refreshed', refresh_token: 'refresh-2', expires_in: 3600 },
    }))
    expect(token).toBe('refreshed')
  })

  it('throws when no token and no refresh_token', async () => {
    await expect(getValidToken('missing', FAKE_CONFIG)).rejects.toThrow(/authorization required/)
  })
})
