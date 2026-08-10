/**
 * MCP OAuth Elicitation Handler
 *
 * Handles OAuth 2.0 authorization code flow for MCP servers that require it.
 * Supports PKCE, local callback server, token storage, and elicitation
 * (server-initiated user prompts for input).
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import { randomBytes, createHash } from 'crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { execSync } from 'child_process'

// ── Types ───────────────────────────────────────────────────────────────────

export interface OAuthConfig {
  clientId: string
  clientSecret?: string
  authorizationEndpoint: string
  tokenEndpoint: string
  redirectUri: string
  scopes: string[]
  /** Server name for namespacing */
  serverName: string
  /** Whether to use PKCE (recommended) */
  usePKCE?: boolean
}

export interface OAuthToken {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  tokenType: string
  scope?: string
}

export interface PKCEChallenge {
  verifier: string
  challenge: string
  method: 'S256'
}

export interface ElicitationRequest {
  id: string
  message: string
  requestedSchema: Record<string, unknown>
  serverName: string
}

export interface ElicitationResponse {
  id: string
  action: 'accept' | 'decline' | 'cancel'
  data?: Record<string, unknown>
}

// ── PKCE ────────────────────────────────────────────────────────────────────

export function generatePKCE(): PKCEChallenge {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge, method: 'S256' }
}

// ── State Parameter ─────────────────────────────────────────────────────────

export function generateState(): string {
  return randomBytes(16).toString('hex')
}

// ── Authorization URL Builder ───────────────────────────────────────────────

export function buildAuthorizationUrl(
  config: OAuthConfig,
  state: string,
  pkce?: PKCEChallenge,
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    state,
    scope: config.scopes.join(' '),
  })

  if (pkce) {
    params.set('code_challenge', pkce.challenge)
    params.set('code_challenge_method', pkce.method)
  }

  const separator = config.authorizationEndpoint.includes('?') ? '&' : '?'
  return `${config.authorizationEndpoint}${separator}${params.toString()}`
}

// ── Token Exchange ──────────────────────────────────────────────────────────

export async function exchangeCodeForToken(
  config: OAuthConfig,
  code: string,
  pkce?: PKCEChallenge,
): Promise<OAuthToken> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
  })

  if (config.clientSecret) {
    body.set('client_secret', config.clientSecret)
  }

  if (pkce) {
    body.set('code_verifier', pkce.verifier)
  }

  const response = await fetch(config.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: body.toString(),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Token exchange failed (${response.status}): ${text}`)
  }

  const data = await response.json() as {
    access_token: string
    refresh_token?: string
    expires_in?: number
    token_type: string
    scope?: string
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    tokenType: data.token_type ?? 'Bearer',
    scope: data.scope,
  }
}

// ── Token Refresh ───────────────────────────────────────────────────────────

export async function refreshToken(
  config: OAuthConfig,
  refreshTokenValue: string,
): Promise<OAuthToken> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshTokenValue,
    client_id: config.clientId,
  })

  if (config.clientSecret) {
    body.set('client_secret', config.clientSecret)
  }

  const response = await fetch(config.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: body.toString(),
  })

  if (!response.ok) {
    throw new Error(`Token refresh failed (${response.status})`)
  }

  const data = await response.json() as {
    access_token: string
    refresh_token?: string
    expires_in?: number
    token_type: string
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshTokenValue,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    tokenType: data.token_type ?? 'Bearer',
  }
}

// ── Callback Server ─────────────────────────────────────────────────────────

export class OAuthCallbackServer {
  private server: Server | null = null
  private codePromise: Promise<{ code: string; state: string }> | null = null
  private codeResolve: ((value: { code: string; state: string }) => void) | null = null
  private codeReject: ((err: Error) => void) | null = null

  constructor(private readonly port: number = 8765) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
        this.handleRequest(req, res)
      })

      this.server.on('error', reject)
      this.server.listen(this.port, () => resolve())

      this.codePromise = new Promise((resolve2, reject2) => {
        this.codeResolve = resolve2
        this.codeReject = reject2
      })
    })
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://localhost:${this.port}`)

    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const error = url.searchParams.get('error')

    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html' })
      res.end(`<h1>Authorization Failed</h1><p>${error}</p>`)
      this.codeReject?.(new Error(`OAuth error: ${error}`))
      return
    }

    if (code && state) {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<h1>Authorization Successful</h1><p>You can close this tab now.</p>')
      this.codeResolve?.({ code, state })
      return
    }

    res.writeHead(404)
    res.end('Not found')
  }

  waitForCode(timeoutMs = 300000): Promise<{ code: string; state: string }> {
    if (!this.codePromise) {
      return Promise.reject(new Error('Server not started'))
    }

    let timeoutTimer: NodeJS.Timeout | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => {
        reject(new Error(`OAuth callback timed out after ${timeoutMs}ms`))
      }, timeoutMs)
    })

    return Promise.race([
      this.codePromise.finally(() => {
        if (timeoutTimer) clearTimeout(timeoutTimer)
      }),
      timeoutPromise,
    ])
  }

  stop(): void {
    if (this.server) {
      this.server.close()
      this.server = null
    }
  }
}

// ── Full Authorization Flow ─────────────────────────────────────────────────

export async function authorize(
  config: OAuthConfig,
  options: { port?: number; openBrowser?: boolean; timeoutMs?: number } = {},
): Promise<OAuthToken> {
  const pkce = config.usePKCE !== false ? generatePKCE() : undefined
  const state = generateState()

  const authUrl = buildAuthorizationUrl(config, state, pkce)

  const callbackServer = new OAuthCallbackServer(options.port ?? 8765)
  await callbackServer.start()

  try {
    if (options.openBrowser !== false) {
      try {
        const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
        execSync(`${openCmd} "${authUrl}"`, { stdio: 'pipe', timeout: 5000 })
      } catch { /* ignore browser open errors */ }
    }

    const { code, state: returnedState } = await callbackServer.waitForCode(options.timeoutMs)

    if (returnedState !== state) {
      throw new Error('OAuth state mismatch — possible CSRF attack')
    }

    const token = await exchangeCodeForToken(config, code, pkce)
    saveToken(config.serverName, token)
    return token
  } finally {
    callbackServer.stop()
  }
}

// ── Token Storage ───────────────────────────────────────────────────────────

function getTokenPath(serverName: string): string {
  return join(homedir(), '.ovolv999', 'oauth-tokens', `${serverName}.json`)
}

export function saveToken(serverName: string, token: OAuthToken): void {
  const path = getTokenPath(serverName)
  const dir = join(path, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(token, null, 2))
}

export function loadToken(serverName: string): OAuthToken | null {
  const path = getTokenPath(serverName)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as OAuthToken
  } catch {
    return null
  }
}

export function deleteToken(serverName: string): boolean {
  const path = getTokenPath(serverName)
  if (!existsSync(path)) return false
  try {
    writeFileSync(path, '') // clear rather than unlink (safer)
    return true
  } catch {
    return false
  }
}

export function isTokenExpired(token: OAuthToken, leewayMs = 60000): boolean {
  if (!token.expiresAt) return false
  return Date.now() + leewayMs >= token.expiresAt
}

export async function getValidToken(config: OAuthConfig): Promise<OAuthToken | null> {
  const token = loadToken(config.serverName)
  if (!token) return null

  if (!isTokenExpired(token)) return token

  if (token.refreshToken) {
    try {
      const refreshed = await refreshToken(config, token.refreshToken)
      saveToken(config.serverName, refreshed)
      return refreshed
    } catch {
      deleteToken(config.serverName)
      return null
    }
  }

  return null
}

// ── Elicitation ─────────────────────────────────────────────────────────────

const pendingElicitations = new Map<string, { resolve: (r: ElicitationResponse) => void; request: ElicitationRequest }>()

export function createElicitation(
  serverName: string,
  message: string,
  requestedSchema: Record<string, unknown>,
): { id: string; promise: Promise<ElicitationResponse> } {
  const id = `elicit-${randomBytes(8).toString('hex')}`
  const request: ElicitationRequest = { id, message, requestedSchema, serverName }

  const promise = new Promise<ElicitationResponse>((resolve) => {
    pendingElicitations.set(id, { resolve, request })
  })

  return { id, promise }
}

export function respondToElicitation(response: ElicitationResponse): boolean {
  const pending = pendingElicitations.get(response.id)
  if (!pending) return false
  pending.resolve(response)
  pendingElicitations.delete(response.id)
  return true
}

export function getPendingElicitations(): ElicitationRequest[] {
  return Array.from(pendingElicitations.values()).map(p => p.request)
}

export function cancelElicitation(id: string): boolean {
  const pending = pendingElicitations.get(id)
  if (!pending) return false
  pending.resolve({ id, action: 'cancel' })
  pendingElicitations.delete(id)
  return true
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatTokenInfo(token: OAuthToken): string {
  const lines = [
    `Token type: ${token.tokenType}`,
    `Access token: ${token.accessToken.slice(0, 8)}...`,
  ]
  if (token.expiresAt) {
    const remaining = token.expiresAt - Date.now()
    const minutes = Math.round(remaining / 60000)
    lines.push(`Expires: ${minutes > 0 ? `${minutes}min` : 'expired'}`)
  }
  if (token.refreshToken) {
    lines.push(`Refresh token: available`)
  }
  if (token.scope) {
    lines.push(`Scope: ${token.scope}`)
  }
  return lines.join('\n')
}

export function formatElicitationRequest(request: ElicitationRequest): string {
  return [
    `Elicitation from: ${request.serverName}`,
    `  Message: ${request.message}`,
    `  Schema: ${JSON.stringify(request.requestedSchema, null, 2).slice(0, 200)}`,
  ].join('\n')
}
