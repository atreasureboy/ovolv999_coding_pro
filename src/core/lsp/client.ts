/**
 * LSP client — Single source of truth (R8 follow-up).
 *
 * Uses `vscode-jsonrpc` for the wire protocol (Content-Length framing,
 * request id correlation, cancellation, notifications). Replaces the
 * former self-implemented JSON-RPC in `lspClient.ts` (R7-era).
 *
 * Public API surface (the union of the two predecessor files):
 *   - start() / start(rootUri) / stop() / kill() / isRunning() / isOpen
 *   - definition / references / hover / documentSymbols
 *   - workspaceSymbols
 *   - openDocument / changeDocument / saveDocument / closeDocument
 *   - getDiagnostics / waitForDiagnostics
 *
 * Module-level helpers:
 *   - detectServer(languageId)
 *   - getDefaultLspClient(rootUri) / shutdownDefaultLspClient()
 *   - formatDiagnostic / formatDiagnostics
 *   - pathToFileUri / fileUriToPath
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import {
  createMessageConnection,
  type MessageConnection,
} from 'vscode-jsonrpc'

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

export interface Position {
  line: number
  character: number
}

export interface Range {
  start: Position
  end: Position
}

export interface Location {
  uri: string
  range: Range
}

export interface Hover {
  contents: string | { kind: 'markdown' | 'plaintext'; value: string } | Array<string | { language: string; value: string }>
  range?: Range
}

export interface SymbolInformation {
  name: string
  kind: number
  location: Location
  containerName?: string
}

export interface LspClientOptions {
  /** Server command. If omitted, auto-detected via detectServer(). */
  command?: string
  /** Server args. */
  args?: string[]
  /** Spawn cwd. */
  cwd?: string
  /** Extra env. */
  env?: Record<string, string>
  /** Default per-request timeout ms. */
  requestTimeoutMs?: number
  /** Legacy: init timeout ms (alias for requestTimeoutMs). */
  timeoutMs?: number
  /** Workspace root URI (file://...). */
  rootUri?: string
  /** Language ID for default document sync. */
  languageId?: LanguageId
}

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

const DefinitionRequest = 'textDocument/definition'
const ReferencesRequest = 'textDocument/references'
const HoverRequest = 'textDocument/hover'
const DocumentSymbolRequest = 'textDocument/documentSymbol'
const WorkspaceSymbolRequest = 'workspace/symbol'
const PublishDiagnosticsNotification = 'textDocument/publishDiagnostics'

// ── LspClient ───────────────────────────────────────────────────────────────

export class LspClient extends EventEmitter {
  private proc: ChildProcess | null = null
  private connection: MessageConnection | null = null
  private rootUri: string | null = null
  private languageId: LanguageId
  private requestTimeoutMs: number
  private docVersions = new Map<string, number>()
  private diagnostics = new Map<string, LspDiagnostic[]>()
  private serverSpec: ServerSpec | null = null
  private shutdown = false
  private started = false

  constructor(private readonly options: LspClientOptions = {}) {
    super()
    this.languageId = options.languageId ?? 'typescript'
    this.requestTimeoutMs = options.requestTimeoutMs ?? options.timeoutMs ?? 30_000
    this.rootUri = options.rootUri ?? null
  }

  get isOpen(): boolean {
    return this.proc !== null && this.connection !== null && !this.shutdown
  }

  isRunning(): boolean {
    return this.isOpen
  }

  /**
   * Start the LSP server. Returns true on success, false on failure
   * (e.g. server binary not found). The big difference from previous
   * versions: we return a boolean for graceful fallback rather than
   * throwing.
   */
  async start(rootUri?: string): Promise<boolean> {
    if (this.started) return true
    if (rootUri) this.rootUri = rootUri
    if (!this.rootUri) {
      // Caller forgot to provide rootUri — last resort: synthesize from cwd.
      this.rootUri = pathToFileUri(process.cwd())
    }

    this.serverSpec = this.options.command
      ? { command: this.options.command, args: this.options.args ?? [], languageId: this.languageId }
      : detectServer(this.languageId)

    if (!this.serverSpec) return false

    let proc: ChildProcess
    try {
      proc = spawn(this.serverSpec.command, this.serverSpec.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: this.options.cwd,
      })
    } catch {
      return false
    }

    if (!proc.pid) {
      // spawn failed synchronously (e.g. binary not found)
      return false
    }

    this.proc = proc

    proc.on('error', () => this.markClosed())
    proc.on('exit', () => this.markClosed())

    if (!proc.stdout || !proc.stdin) {
      return false
    }

    this.connection = createMessageConnection(
      proc.stdout as unknown as Parameters<typeof createMessageConnection>[0],
      proc.stdin as unknown as Parameters<typeof createMessageConnection>[1],
    )

    this.connection.onError(() => this.markClosed())
    this.connection.onNotification(
      { method: PublishDiagnosticsNotification } as never,
      (params: unknown) => {
        const p = params as { uri?: string; diagnostics?: Array<Record<string, unknown>> } | undefined
        if (p?.uri) {
          const diags = (p.diagnostics ?? []).map((d) => normalizeDiagnostic(p.uri!, d))
          this.diagnostics.set(p.uri, diags)
          this.emit('diagnostics', p.uri, diags)
        }
      },
    )
    this.connection.onNotification(
      { method: 'window/logMessage' } as never,
      (params: unknown) => {
        const p = params as { message?: string } | undefined
        if (p?.message) this.emit('log', p.message)
      },
    )
    this.connection.onNotification(
      { method: 'window/showMessage' } as never,
      (params: unknown) => {
        const p = params as { message?: string } | undefined
        if (p?.message) this.emit('log', p.message)
      },
    )

    this.connection.listen()

    try {
      await this.withTimeout(
        this.connection.sendRequest('initialize', {
          processId: process.pid,
          rootUri: this.rootUri,
          capabilities: {
            textDocument: {
              synchronization: { didOpen: true, didChange: true, didSave: true },
              publishDiagnostics: { relatedInformation: false },
              definition: { dynamicRegistration: false },
              references: { dynamicRegistration: false },
              hover: { contentFormat: ['plaintext', 'markdown'] },
              documentSymbol: { dynamicRegistration: false },
            },
            workspace: { symbol: true },
          },
        }),
        'initialize',
      )

      this.connection.sendNotification({ method: 'initialized' } as never, {})  // eslint-disable-line @typescript-eslint/no-floating-promises
      this.started = true
      return true
    } catch {
      this.kill()
      return false
    }
  }

  async stop(): Promise<void> {
    if (this.shutdown) return
    this.shutdown = true
    if (this.connection && this.started) {
      try { await this.withTimeout(this.connection.sendRequest({ method: 'shutdown' } as never, null), 'shutdown', 3000) } catch { /* ignore */ }
      this.connection.sendNotification({ method: 'exit' } as never, null)  // eslint-disable-line @typescript-eslint/no-floating-promises
    }
    this.kill()
  }

  kill(): void {
    this.started = false
    if (this.connection) {
      try { this.connection.dispose() } catch { /* noop */ }
      this.connection = null
    }
    if (this.proc) {
      try { this.proc.kill('SIGTERM') } catch { /* ignore */ }
      this.proc = null
    }
    this.emit('close')
  }

  // ── Document Sync ─────────────────────────────────────────────────────

  openDocument(uri: string, text: string, languageId?: string): Promise<void> {
    if (!this.isRunning()) return Promise.resolve()
    const version = 1
    this.docVersions.set(uri, version)
    this.connection?.sendNotification(  // eslint-disable-line @typescript-eslint/no-floating-promises
      { method: 'textDocument/didOpen' } as never,
      {
        textDocument: {
          uri,
          languageId: languageId ?? this.languageId,
          version,
          text,
        },
      },
    )
    return Promise.resolve()
  }

  changeDocument(uri: string, text: string, version: number): void {
    if (!this.isRunning()) return
    this.docVersions.set(uri, version)
    this.connection?.sendNotification(  // eslint-disable-line @typescript-eslint/no-floating-promises
      { method: 'textDocument/didChange' } as never,
      {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      },
    )
  }

  saveDocument(uri: string, text?: string): void {
    if (!this.isRunning()) return
    this.connection?.sendNotification(  // eslint-disable-line @typescript-eslint/no-floating-promises
      { method: 'textDocument/didSave' } as never,
      { textDocument: { uri }, text },
    )
  }

  closeDocument(uri: string): void {
    if (!this.isRunning()) return
    this.connection?.sendNotification(  // eslint-disable-line @typescript-eslint/no-floating-promises
      { method: 'textDocument/didClose' } as never,
      { textDocument: { uri } },
    )
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

  // ── Code Navigation ───────────────────────────────────────────────────

  async definition(uri: string, position: Position): Promise<Location[]> {
    const conn = this.requireConn()
    const result = await this.withTimeout(
      conn.sendRequest(
        DefinitionRequest,
        { textDocument: { uri }, position } as never,
      ),
      'definition',
    )
    if (!result) return []
    return Array.isArray(result) ? (result as Location[]) : [result as Location]
  }

  async references(uri: string, position: Position): Promise<Location[]> {
    const conn = this.requireConn()
    const result = await this.withTimeout(
      conn.sendRequest(
        ReferencesRequest,
        { textDocument: { uri }, position, context: { includeDeclaration: true } } as never,
      ),
      'references',
    )
    return (result as Location[] | null) ?? []
  }

  async hover(uri: string, position: Position): Promise<Hover | null> {
    const conn = this.requireConn()
    return await this.withTimeout(
      conn.sendRequest(
        HoverRequest,
        { textDocument: { uri }, position } as never,
      ),
      'hover',
    )
  }

  async documentSymbols(uri: string): Promise<SymbolInformation[]> {
    const conn = this.requireConn()
    const result = await this.withTimeout(
      conn.sendRequest(
        DocumentSymbolRequest,
        { textDocument: { uri } } as never,
      ),
      'documentSymbol',
    )
    return (result as SymbolInformation[] | null) ?? []
  }

  async workspaceSymbols(query: string): Promise<LspSymbol[]> {
    if (!this.isRunning()) return []
    const conn = this.requireConn()
    try {
      const result = await this.withTimeout(
        conn.sendRequest(WorkspaceSymbolRequest, { query } as never),
        'workspace/symbol',
      )
      return (result as LspSymbol[]) ?? []
    } catch {
      return []
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private requireConn(): MessageConnection {
    if (!this.connection || this.shutdown) {
      throw new Error('LSP client not started')
    }
    return this.connection
  }

  private withTimeout<T>(promise: Promise<T>, method: string, overrideMs?: number): Promise<T> {
    const timeout = overrideMs ?? this.requestTimeoutMs
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`LSP ${method} timed out`))
      }, timeout)
      promise.then(
        (v) => { clearTimeout(timer); resolve(v) },
        (e) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))) },
      )
    })
  }

  private markClosed(): void {
    if (this.shutdown) return
    this.shutdown = true
    if (this.connection) {
      try { this.connection.dispose() } catch { /* noop */ }
      this.connection = null
    }
    if (this.proc) {
      this.proc = null
    }
  }
}

// ── Server Detection ───────────────────────────────────────────────────────

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

// ── Helpers ────────────────────────────────────────────────────────────────

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

export function pathToFileUri(absPath: string): string {
  // Recognize Windows paths (e.g. "C:\Users\file.ts") regardless of
  // host platform so tests + serialized URIs are stable across OSes.
  // When path is a Windows drive-letter path, just normalize backslashes.
  if (/^[A-Za-z]:[\\/]/.test(absPath)) {
    const normalized = absPath.replace(/\\/g, '/')
    return `file:///${normalized}`
  }
  const resolved = resolve(absPath)
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

// ── Formatting ─────────────────────────────────────────────────────────────

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

// ── Singleton Convenience ──────────────────────────────────────────────────

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

// Silence unused-import warnings for types referenced only in JSDoc
export type { Readable, Writable }
