/**
 * lspTool — exposes LSP navigation methods (definition / references /
 * hover / documentSymbol) to the LLM.
 *
 * Wire-up:
 *   - Server config from ~/.ovogo/settings.json `lsp.servers[name]`
 *     - command, args, cwd, env, fileExtensions
 *   - First matching server (by file extension) handles the request
 *   - LSP processes are spawned lazily on first request per server
 *   - Each session creates its own LspClient (per-server)
 *
 * When no LSP server matches the file's extension, the tool returns
 * an explanatory message — never crashes the turn.
 */

import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../core/types.js'
import { LspClient, pathToFileUri } from '../core/lsp/client.js'
import { LSP_SYMBOL_KIND_NAMES } from '../core/lsp/protocol.js'
import { str } from '../core/strings.js'
import { homedir } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface LspServerConfig {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  fileExtensions?: string[]
}

export interface LspToolOptions {
  /** Map of server name -> config. Loaded from settings.lsp.servers. */
  servers: Record<string, LspServerConfig>
}

interface ServerState {
  client: LspClient
  initializedFor: Set<string>
}

/**
 * Round 40 (opencode read→LSP warmup): shared server-state registry keyed
 * by cwd::name. Previously each createLspTool() instance held its own
 * closure-scoped map, so a warmup spawned by FileRead could never share
 * the live client with the LSP tool. Module-level so both paths converge
 * on one LspClient per (cwd, server).
 */
const sharedServerStates = new Map<string, ServerState>()

/** One warmup attempt per (cwd, server) — never retry a failed spawn. */
const warmAttempted = new Set<string>()

/**
 * Round 41 audit fix: in-flight get-or-start dedupe. The check-then-await-
 * then-set window (LSP initialize takes seconds) let a Read-triggered
 * warmup and a concurrent lsp tool call BOTH spawn the server — the loser
 * was overwritten in the map and its process orphaned. One promise per key.
 */
const inflight = new Map<string, Promise<ServerState | { error: string }>>()

let cachedSettingsServers: { value: Record<string, LspServerConfig>; at: number } | null = null
const SETTINGS_TTL_MS = 10_000

function settingsServersCached(): Record<string, LspServerConfig> {
  if (!cachedSettingsServers || Date.now() - cachedSettingsServers.at > SETTINGS_TTL_MS) {
    cachedSettingsServers = { value: loadLspServersFromSettings(), at: Date.now() }
  }
  return cachedSettingsServers.value
}

/** Reset caches (tests). */
export function _resetLspToolCaches(): void {
  cachedSettingsServers = null
  warmAttempted.clear()
  inflight.clear()
}

/** Test seam: view the shared registry (tests inject fake clients here). */
export function _lspRegistryForTests(): Map<string, ServerState> {
  return sharedServerStates
}

/**
 * Tear down every shared LSP server (best-effort). engineAssembly.dispose()
 * calls this so a language server spawned mid-session cannot outlive the
 * CLI process — previously nothing ever stopped these clients.
 */
export async function shutdownAllLspServers(): Promise<void> {
  // Let in-flight spawns settle first so their clients are in the
  // registry (and get stopped) instead of registering a live server
  // after the sweep.
  await Promise.allSettled([...inflight.values()])
  const stops: Array<Promise<void>> = []
  for (const state of sharedServerStates.values()) {
    try { stops.push(state.client.stop()) } catch { /* best-effort: never block teardown */ }
  }
  sharedServerStates.clear()
  warmAttempted.clear()
  await Promise.allSettled(stops)
}

/**
 * Get-or-start the shared LSP server for (cwd, name). Same contract as
 * the tool's internal path: resolves a ServerState or an { error }.
 *
 * Round 41 audit fix: a client whose server process DIED used to stay in
 * the registry forever — every later lsp call hit a dead connection with
 * no recovery until host restart. Dead entries are evicted (and their
 * warmup marker cleared) so the next call spawns a replacement.
 */
async function getOrInitSharedServer(
  name: string,
  config: LspServerConfig,
  cwd: string,
): Promise<ServerState | { error: string }> {
  const key = `${cwd}::${name}`
  const existing = sharedServerStates.get(key)
  if (existing && existing.initializedFor.has(cwd)) {
    if (existing.client.isOpen) return existing
    // Server died — evict so the spawn below replaces it.
    sharedServerStates.delete(key)
    warmAttempted.delete(key)
  }
  const pendingStart = inflight.get(key)
  if (pendingStart) return pendingStart

  const start = (async (): Promise<ServerState | { error: string }> => {
    const client = new LspClient({
      command: config.command,
      args: config.args,
      cwd: config.cwd ?? cwd,
      env: config.env,
    })
    try {
      const started = await client.start(pathToFileUri(cwd))
      if (!started) {
        return { error: `LSP server '${name}' failed to start (binary not found or spawn error)` }
      }
      const state: ServerState = existing ?? { client, initializedFor: new Set() }
      state.initializedFor.add(cwd)
      sharedServerStates.set(key, state)
      return state
    } catch (err) {
      return { error: `LSP server '${name}' failed to start: ${(err as Error).message}` }
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, start)
  return start
}

/**
 * Fire-and-forget warmup for the LSP server matching `filePath`'s
 * extension (opencode's read→warmup pattern): by the time the model calls
 * the LSP tool, the server is already initialized and the first
 * definition/references call doesn't eat the multi-second cold start.
 * At most ONE attempt per (cwd, server); failures are swallowed — warmup
 * must never affect the Read result.
 */
export function warmLspForFile(filePath: string, cwd: string): boolean {
  const entry = findServerFor(filePath, settingsServersCached())
  if (!entry) return false
  const attemptKey = `${cwd}::${entry.name}`
  if (warmAttempted.has(attemptKey)) return true
  warmAttempted.add(attemptKey)
  void getOrInitSharedServer(entry.name, entry.config, cwd).catch(() => {
    /* best-effort — the LSP tool surfaces real errors on demand */
  })
  return true
}

export function loadLspServersFromSettings(): Record<string, LspServerConfig> {
  const settingsPath = join(homedir(), '.ovogo', 'settings.json')
  if (!existsSync(settingsPath)) return {}
  try {
    const raw = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      lsp?: { servers?: Record<string, LspServerConfig> }
    }
    return raw.lsp?.servers ?? {}
  } catch {
    return {}
  }
}

export function findServerFor(uri: string, servers: Record<string, LspServerConfig>): { name: string; config: LspServerConfig } | null {
  const ext = uri.match(/\.[a-zA-Z0-9]+$/)?.[0]?.toLowerCase()
  if (!ext) return null
  for (const [name, config] of Object.entries(servers)) {
    if (config.fileExtensions?.some((e) => e.toLowerCase() === ext)) {
      return { name, config }
    }
  }
  return null
}

export function createLspTool(options: LspToolOptions): Tool {
  // Round 40: delegates to the module-level shared registry so warmups
  // started by FileRead reuse the SAME LspClient the tool queries later.
  async function getOrInitServer(
    name: string,
    config: LspServerConfig,
    cwd: string,
  ): Promise<ServerState | { error: string }> {
    return getOrInitSharedServer(name, config, cwd)
  }

  return {
    name: 'lsp',
    metadata: { readOnly: true, concurrencySafe: false, searchHint: 'language server go to definition find references hover symbol' },
    definition: {
      type: 'function',
      function: {
        name: 'lsp',
        description: `Language Server Protocol navigation. Use these to find code definitions, references, type info, and document symbols without reading every file. Configure LSP servers in ~/.ovogo/settings.json under 'lsp.servers'.

Methods:
  - definition: Find where a symbol is defined
  - references: Find all uses of a symbol
  - hover: Get type signature / docs for a position
  - documentSymbol: List top-level symbols in a file

Server is selected by file extension.`,
        parameters: {
          type: 'object',
          properties: {
            method: {
              type: 'string',
              enum: ['definition', 'references', 'hover', 'documentSymbol'],
              description: 'Which LSP method to invoke',
            },
            uri: {
              type: 'string',
              description: 'File URI (e.g. file:///path/to/file.ts)',
            },
            line: {
              type: 'number',
              description: 'Zero-indexed line number (required for definition/references/hover)',
            },
            character: {
              type: 'number',
              description: 'Zero-indexed character offset on the line (required for definition/references/hover)',
            },
          },
          required: ['method', 'uri'],
        },
      },
    } satisfies ToolDefinition,

    execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const method = str(input.method)
      const uri = str(input.uri)
      if (!method || !uri) {
        return Promise.resolve({
          content: 'Error: method and uri are required',
          isError: true,
        })
      }

      const serverEntry = findServerFor(uri, options.servers)
      if (!serverEntry) {
        return Promise.resolve({
          content: `Error: no LSP server configured for ${uri}. Add one in ~/.ovogo/settings.json.`,
          isError: true,
        })
      }

      return (async () => {
        const cwd = context.cwd
        const initResult = await getOrInitServer(serverEntry.name, serverEntry.config, cwd)
        if ('error' in initResult) {
          return { content: initResult.error, isError: true }
        }
        const state = initResult
        const line = typeof input.line === 'number' ? input.line : -1
        const character = typeof input.character === 'number' ? input.character : -1
        try {
          switch (method) {
            case 'definition': {
              if (line < 0 || character < 0) return { content: 'Error: line and character required', isError: true }
              const locations = await state.client.definition(uri, { line, character })
              return {
                content: locations.length === 0
                  ? 'No definition found'
                  : locations.map((l) => `${l.uri}:${l.range.start.line}:${l.range.start.character}`).join('\n'),
                isError: false,
              }
            }
            case 'references': {
              if (line < 0 || character < 0) return { content: 'Error: line and character required', isError: true }
              const locations = await state.client.references(uri, { line, character })
              return {
                content: locations.length === 0
                  ? 'No references found'
                  : locations.map((l) => `${l.uri}:${l.range.start.line}:${l.range.start.character}`).join('\n'),
                isError: false,
              }
            }
            case 'hover': {
              if (line < 0 || character < 0) return { content: 'Error: line and character required', isError: true }
              const hover = await state.client.hover(uri, { line, character })
              if (!hover) return { content: 'No hover info', isError: false }
              const content = typeof hover.contents === 'string'
                ? hover.contents
                : Array.isArray(hover.contents)
                  ? hover.contents.map((c) => typeof c === 'string' ? c : c.value).join('\n')
                  : hover.contents.value
              return { content, isError: false }
            }
            case 'documentSymbol': {
              const symbols = await state.client.documentSymbols(uri)
              return {
                content: symbols.length === 0
                  ? 'No symbols'
                  : symbols.map((s) => `${LSP_SYMBOL_KIND_NAMES[s.kind] ?? '?'}: ${s.name} @ ${s.location.uri}:${s.location.range.start.line}`).join('\n'),
                isError: false,
              }
            }
            default:
              return { content: `Error: unknown method ${method}`, isError: true }
          }
        } catch (err) {
          return { content: `LSP ${method} failed: ${(err as Error).message}`, isError: true }
        }
      })()
    },
  }
}
