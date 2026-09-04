/**
 * MCP OAuth 2.1 client (Authorization Code + PKCE).
 *
 * Zero-deps implementation: uses Node's built-in fetch + crypto.
 *
 * Token storage: `~/.ovogo/mcp-tokens.json` with 0600 perms.
 * Supports: refresh_token grant for automatic renewal; expires_at
 * tracked locally so we re-refresh proactively.
 *
 * Out of scope: Dynamic Client Registration, mTLS client auth, JWT
 * bearer profile, resource indicators (RFC 8707).
 */

import { readFileSync, existsSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteSync } from '../core/atomicWrite.js'
import { homedir } from 'node:os'
import { createHash, randomBytes } from 'node:crypto'

export interface OAuthTokenSet {
  serverId: string
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  scope?: string
  tokenType?: string
  acquiredAt: number
}

export interface OAuthConfig {
  serverId: string
  authorizationEndpoint: string
  tokenEndpoint: string
  clientId: string
  clientSecret?: string
  scope?: string
  redirectUri: string
}

export interface OAuthPkcePair {
  codeVerifier: string
  codeChallenge: string
  state: string
}

export function generatePkcePair(): OAuthPkcePair {
  const codeVerifier = randomBytes(32).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  const state = randomBytes(16).toString('hex')
  return { codeVerifier, codeChallenge, state }
}

export function buildAuthorizationUrl(config: OAuthConfig, pkce: OAuthPkcePair): string {
  const url = new URL(config.authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', config.redirectUri)
  url.searchParams.set('code_challenge', pkce.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', pkce.state)
  if (config.scope) url.searchParams.set('scope', config.scope)
  return url.toString()
}

export interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  token_type?: string
}

export async function exchangeCodeForToken(
  config: OAuthConfig,
  code: string,
  pkce: OAuthPkcePair,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthTokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    code_verifier: pkce.codeVerifier,
  })
  if (config.clientSecret) body.set('client_secret', config.clientSecret)

  const response = await fetchImpl(config.tokenEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: body.toString(),
  })
  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    throw new Error(`OAuth token exchange failed: ${response.status} ${errText.slice(0, 500)}`)
  }
  const json = (await response.json()) as TokenResponse
  return tokenResponseToSet(config.serverId, json)
}

export async function refreshToken(
  config: OAuthConfig,
  refreshTokenValue: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthTokenSet> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshTokenValue,
    client_id: config.clientId,
  })
  if (config.clientSecret) body.set('client_secret', config.clientSecret)

  const response = await fetchImpl(config.tokenEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: body.toString(),
  })
  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    throw new Error(`OAuth refresh failed: ${response.status} ${errText.slice(0, 500)}`)
  }
  const json = (await response.json()) as TokenResponse
  return tokenResponseToSet(config.serverId, json)
}

function tokenResponseToSet(serverId: string, response: TokenResponse): OAuthTokenSet {
  const now = Date.now()
  const expiresAt = response.expires_in ? now + response.expires_in * 1000 : undefined
  return {
    serverId,
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt,
    scope: response.scope,
    tokenType: response.token_type ?? 'Bearer',
    acquiredAt: now,
  }
}

export function getTokenStorePath(): string {
  return join(homedir(), '.ovogo', 'mcp-tokens.json')
}

export function loadTokenStore(): Map<string, OAuthTokenSet> {
  const path = getTokenStorePath()
  if (!existsSync(path)) return new Map()
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as { tokens: OAuthTokenSet[] }
    return new Map(parsed.tokens.map((t) => [t.serverId, t]))
  } catch {
    return new Map()
  }
}

export function saveTokenStore(store: Map<string, OAuthTokenSet>): void {
  const path = getTokenStorePath()
  atomicWriteSync(path, JSON.stringify({ tokens: Array.from(store.values()) }, null, 2))
  try { chmodSync(path, 0o600) } catch { /* best-effort */ }
}

export async function getValidToken(
  serverId: string,
  config: OAuthConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const store = loadTokenStore()
  const existing = store.get(serverId)
  const now = Date.now()
  const REFRESH_WINDOW_MS = 60_000
  if (existing && (!existing.expiresAt || existing.expiresAt - now > REFRESH_WINDOW_MS)) {
    return existing.accessToken
  }
  if (existing?.refreshToken) {
    const refreshed = await refreshToken(config, existing.refreshToken, fetchImpl)
    store.set(serverId, refreshed)
    saveTokenStore(store)
    return refreshed.accessToken
  }
  throw new Error(`No valid token for MCP server ${serverId}; authorization required`)
}

export function deleteToken(serverId: string): boolean {
  const store = loadTokenStore()
  const had = store.delete(serverId)
  if (had) saveTokenStore(store)
  return had
}

export function storeToken(token: OAuthTokenSet): void {
  const store = loadTokenStore()
  store.set(token.serverId, token)
  saveTokenStore(store)
}
