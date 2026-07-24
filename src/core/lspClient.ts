/**
 * In-process LSP Client
 *
 * Manages a persistent language-server process (default: TypeScript
 * tsserver) for fast, incremental diagnostics without shelling out to
 * `tsc --noEmit` on every request.
 *
 * Protocol: minimal LSP-over-stdio (JSON-RPC 2.0 with Content-Length
 * framing). We only implement the subset we need:
 *   - initialize / shutdown
 *   - textDocument/didOpen, didChange, didSave
 *   - textDocument/publishDiagnostics (notification)
 *   - workspace/symbol (for code navigation)
 *
 * If the language server binary isn't found or fails to start, all
 * operations degrade gracefully (return empty results) so the caller
 * — usually the Diagnostics tool — falls back to a tsc shellout.
 */

import { spawn, execSync, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { resolve } from 'path'
import { existsSync } from 'fs'

// ── Types ───────────────────────────────────────────────────────────────────

export type LanguageId = 'typescript' | 'javascript' | 'python' | 'rust' | 'go'

export interface LspPosition {
  line: number
  character: number
}

export interface LspRange {
  start: LspPosition
  end: LspPosition
}

export interface LspDiagnostic {
  uri: string
  range: LspRange
  severity: 'error' | 'warning' | 'information' | 'hint'
  code?: string | number
  source?: string
  message: string
}

export interface LspSymbol {
  name: string
  kind: number
  location: { uri: string; range: LspRange }
  containerName?: string
}

export interface LspClientOptions {
  /** Server command (default: auto-detect tsserver) */
  command?: string
  /** Server args */
  args?: string[]
  /** Workspace root */
  rootUri: string
  /** Language ID */
  languageId?: LanguageId
  /** Init timeout ms */
  timeoutMs?: number
}

interface LspMessage {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

// ── Server Detection ────────────────────────────────────────────────────────

interface ServerSpec {
  command: string
  args: string[]
  languageId: LanguageId
}

const SERVER_PATTERNS: Record<LanguageId, ServerSpec[]> = {
  typescript: [
    { command: 'typescript-language-server', args: ['--stdio'], languageId: 'typescript' },
    { command: 'tsserver', args: [], languageId: 'typescript' },
  ],
  javascript: [
    { command: 'typescript-language-server', args: ['--stdio'], languageId: 'javascript' },
  ],
  python: [
    { command: 'pylsp', args: [], languageId: 'python' },
    { command: 'pyright-langserver', args: ['--stdio'], languageId: 'python' },
    { command: 'ruff-lsp', args: [], languageId: 'python' },
  ],
  rust: [
    { command: 'rust-analyzer', args: [], languageId: 'rust' },
  ],
  go: [
    { command: 'gopls', args: [], languageId: 'go' },
  ],
}

export function detectServer(languageId: LanguageId = 'typescript'): ServerSpec | null {
  const specs = SERVER_PATTERNS[languageId]
  if (!specs) return null

  // Check TS-specific path: node_modules/.bin/tsserver
  if (languageId === 'typescript' || languageId === 'javascript') {
    const localTsserver = resolve(process.cwd(), 'node_modules', '.bin', 'tsserver')
    if (existsSync(localTsserver)) {
      return { command: 'node', args: [localTsserver], languageId }
    }
    const localTsLs = resolve(process.cwd(), 'node_modules', '.bin', 'typescript-language-server')
    if (existsSync(localTsLs)) {
      return { command: localTsLs, args: ['--stdio'], languageId }
    }
  }

  for (const spec of specs) {
    try {
      execSync(`which ${spec.command} 2>/dev/null`, { stdio: 'pipe', timeout: 2000 })
      return spec
    } catch { /* not found */ }
  }

  return null
}

// ── LSP Client ──────────────────────────────────────────────────────────────

export class LspClient extends EventEmitter {
  private proc: ChildProcess | null = null
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private buffer = ''
  private initialized = false
  private diagnostics = new Map<string, LspDiagnostic[]>()
  private serverSpec: ServerSpec | null = null
  private options: LspClientOptions
  private shutdown = false

  constructor(options: LspClientOptions) {
    super()
    this.options = { timeoutMs: 15000, languageId: 'typescript', ...options }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  async start(): Promise<boolean> {
    if (this.initialized) return true

    this.serverSpec = this.options.command
      ? { command: this.options.command, args: this.options.args ?? [], languageId: this.options.languageId ?? 'typescript' }
      : detectServer(this.options.languageId)

    if (!this.serverSpec) return false

    try {
      this.proc = spawn(this.serverSpec.command, this.serverSpec.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: fileUriToPath(this.options.rootUri),
      })
    } catch {
      return false
    }

    if (!this.proc.stdout || !this.proc.stdin) {
      return false
    }

    // If spawn failed (nonexistent binary), pid is undefined and an
    // 'error' event fires on the next tick. Set up a guard so start()
    // rejects quickly rather than waiting for the full init timeout.
    if (!this.proc.pid) {
      return false
    }

    // During initialization, a spawn-error (ENOENT etc.) should reject
    // the initialize request immediately instead of waiting for timeout.
    const initErrorHandler = (err: Error): void => {
      for (const [, { reject }] of this.pending) reject(err)
      this.pending.clear()
    }
    this.proc.once('error', initErrorHandler)

    this.proc.stdout.on('data', (data: Buffer) => this.onData(data))
    this.proc.on('exit', () => {
      this.initialized = false
      this.proc = null
    })

    // Initialize
    try {
      await this.request('initialize', {
        processId: process.pid,
        rootUri: this.options.rootUri,
        capabilities: {
          textDocument: {
            synchronization: { didOpen: true, didChange: true, didSave: true },
            publishDiagnostics: { relatedInformation: false },
          },
          workspace: { symbol: true },
        },
      }, this.options.timeoutMs)

      this.notify('initialized', {})
      this.initialized = true
      return true
    } catch {
      this.kill()
      return false
    }
  }

  isRunning(): boolean {
    return this.initialized && this.proc !== null
  }

  // ── Document Sync ─────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/require-await
  async openDocument(uri: string, text: string, languageId?: string): Promise<void> {
    if (!this.isRunning()) return
    this.notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: languageId ?? this.options.languageId ?? 'typescript',
        version: 1,
        text,
      },
    })
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async changeDocument(uri: string, text: string, version: number): Promise<void> {
    if (!this.isRunning()) return
    this.notify('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    })
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async saveDocument(uri: string, text?: string): Promise<void> {
    if (!this.isRunning()) return
    this.notify('textDocument/didSave', {
      textDocument: { uri },
      text,
    })
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async closeDocument(uri: string): Promise<void> {
    if (!this.isRunning()) return
    this.notify('textDocument/didClose', { textDocument: { uri } })
  }

  // ── Diagnostics ───────────────────────────────────────────────────────

  getDiagnostics(uri?: string): LspDiagnostic[] {
    if (uri) return this.diagnostics.get(uri) ?? []
    const all: LspDiagnostic[] = []
    for (const diags of this.diagnostics.values()) all.push(...diags)
    return all
  }

  waitForDiagnostics(uri: string, timeoutMs = 5000): Promise<LspDiagnostic[]> {
    return new Promise((resolve) => {
      const existing = this.diagnostics.get(uri)
      if (existing && existing.length >= 0) {
        // Give the server a moment to publish after didOpen
      }
      const timer = setTimeout(() => {
        cleanup()
        resolve(this.diagnostics.get(uri) ?? [])
      }, timeoutMs)

      const handler = (publishedUri: string): void => {
        if (publishedUri === uri) {
          cleanup()
          resolve(this.diagnostics.get(uri) ?? [])
        }
      }

      const cleanup = (): void => {
        clearTimeout(timer)
        this.removeListener('diagnostics', handler)
      }

      this.on('diagnostics', handler)
    })
  }

  // ── Symbols ───────────────────────────────────────────────────────────

  async workspaceSymbols(query: string): Promise<LspSymbol[]> {
    if (!this.isRunning()) return []
    try {
      const result = await this.request('workspace/symbol', { query }, this.options.timeoutMs)
      return (result as LspSymbol[]) ?? []
    } catch {
      return []
    }
  }

  // ── Shutdown ──────────────────────────────────────────────────────────

  async stop(): Promise<void> {
    if (this.shutdown) return
    this.shutdown = true

    if (this.proc && this.initialized) {
      try {
        await this.request('shutdown', {}, 3000)
        this.notify('exit', {})
      } catch { /* ignore */ }
    }
    this.kill()
  }

  kill(): void {
    this.initialized = false
    if (this.proc) {
      try { this.proc.kill('SIGTERM') } catch { /* ignore */ }
      this.proc = null
    }
    for (const [, { reject }] of this.pending) reject(new Error('LSP client stopped'))
    this.pending.clear()
  }

  // ── Protocol ──────────────────────────────────────────────────────────

  private onData(data: Buffer): void {
    this.buffer += data.toString('utf8')

    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) break

      const header = this.buffer.slice(0, headerEnd)
      const match = header.match(/Content-Length:\s*(\d+)/i)
      if (!match) break

      const length = parseInt(match[1], 10)
      const bodyStart = headerEnd + 4
      if (this.buffer.length < bodyStart + length) break

      const body = this.buffer.slice(bodyStart, bodyStart + length)
      this.buffer = this.buffer.slice(bodyStart + length)

      try {
        const msg = JSON.parse(body) as LspMessage
        this.handleMessage(msg)
      } catch { /* malformed JSON */ }
    }
  }

  private handleMessage(msg: LspMessage): void {
    // Response to a request
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id as number)
      if (pending) {
        this.pending.delete(msg.id as number)
        if (msg.error) {
          pending.reject(new Error(msg.error.message))
        } else {
          pending.resolve(msg.result)
        }
      }
      return
    }

    // Notification
    if (msg.method) {
      switch (msg.method) {
        case 'textDocument/publishDiagnostics': {
          const params = msg.params as { uri: string; diagnostics: Array<Record<string, unknown>> }
          if (params?.uri) {
            const diags = (params.diagnostics ?? []).map((d) => normalizeDiagnostic(params.uri, d))
            this.diagnostics.set(params.uri, diags)
            this.emit('diagnostics', params.uri, diags)
          }
          break
        }
        case 'window/logMessage':
        case 'window/showMessage': {
          const params = msg.params as { message?: string }
          if (params?.message) this.emit('log', params.message)
          break
        }
      }
    }
  }

  private request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin?.writable) {
        reject(new Error('LSP server not connected'))
        return
      }

      const id = this.nextId++
      const msg: LspMessage = { jsonrpc: '2.0', id, method, params }

      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`LSP request timed out: ${method}`))
      }, timeoutMs ?? 15000)

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })

      this.sendMessage(msg)
    })
  }

  private notify(method: string, params: unknown): void {
    if (!this.proc?.stdin?.writable) return
    this.sendMessage({ jsonrpc: '2.0', method, params })
  }

  private sendMessage(msg: LspMessage): void {
    const body = JSON.stringify(msg)
    const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`
    this.proc?.stdin?.write(header + body)
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function normalizeDiagnostic(uri: string, raw: Record<string, unknown>): LspDiagnostic {
  const severityMap = ['error', 'warning', 'information', 'hint']
  const severity = typeof raw.severity === 'number'
    ? severityMap[raw.severity - 1] ?? 'information'
    : 'error'

  const range = raw.range as { start: LspPosition; end: LspPosition } | undefined

  return {
    uri,
    range: range ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    severity: severity as LspDiagnostic['severity'],
    code: raw.code as string | number | undefined,
    source: raw.source as string | undefined,
    message: (raw.message as string) ?? '(no message)',
  }
}

export function pathToFileUri(path: string): string {
  const resolved = resolve(path)
  const normalized = process.platform === 'win32'
    ? resolved.replace(/\\/g, '/')
    : resolved
  return `file://${process.platform === 'win32' ? '/' : ''}${normalized}`
}

export function fileUriToPath(uri: string): string {
  if (uri.startsWith('file://')) {
    const path = uri.slice(7)
    if (process.platform === 'win32') {
      return path.replace(/^\//, '').replace(/\//g, '\\')
    }
    return path
  }
  return uri
}

// ── Singleton Convenience ───────────────────────────────────────────────────

let defaultClient: LspClient | null = null

export function getDefaultLspClient(rootUri: string): LspClient {
  if (!defaultClient) {
    defaultClient = new LspClient({ rootUri })
  }
  return defaultClient
}

export async function shutdownDefaultLspClient(): Promise<void> {
  if (defaultClient) {
    await defaultClient.stop()
    defaultClient = null
  }
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatDiagnostic(d: LspDiagnostic): string {
  const pos = `${d.range.start.line + 1}:${d.range.start.character + 1}`
  const code = d.code !== undefined ? ` [${d.code}]` : ''
  const src = d.source ? ` (${d.source})` : ''
  return `${d.uri}:${pos} ${d.severity}${code}${src}: ${d.message}`
}

export function formatDiagnostics(diagnostics: LspDiagnostic[]): string {
  if (diagnostics.length === 0) return 'No diagnostics.'
  const bySeverity = {
    error: diagnostics.filter((d) => d.severity === 'error'),
    warning: diagnostics.filter((d) => d.severity === 'warning'),
    information: diagnostics.filter((d) => d.severity === 'information'),
    hint: diagnostics.filter((d) => d.severity === 'hint'),
  }
  const lines = [
    `Diagnostics: ${diagnostics.length} (${bySeverity.error.length} errors, ${bySeverity.warning.length} warnings)`,
  ]
  for (const d of diagnostics.slice(0, 50)) {
    lines.push(`  ${formatDiagnostic(d)}`)
  }
  if (diagnostics.length > 50) {
    lines.push(`  ... and ${diagnostics.length - 50} more`)
  }
  return lines.join('\n')
}
