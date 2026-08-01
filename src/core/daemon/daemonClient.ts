/**
 * Daemon client — connect to a running DaemonServer and dispatch
 * requests over HTTP (loopback).
 *
 * Used by `ovolv999 --attach <sessionId>` and `ovolv999 mcp
 * daemon-attach` subcommands.
 */

import type { DaemonRequest, DaemonResponse, DaemonEvent } from './daemonServer.js'

export interface DaemonClientOptions {
  /** Daemon host (default: 127.0.0.1). */
  host?: string
  /** Daemon port. Falls back to `process.env.OVOGO_DAEMON_PORT`. */
  port?: number
  /** Override fetch implementation (for tests). */
  fetchImpl?: typeof fetch
}

export class DaemonClient {
  private readonly host: string
  private readonly port: number
  private readonly fetchImpl: typeof fetch

  constructor(options: DaemonClientOptions = {}) {
    this.host = options.host ?? '127.0.0.1'
    if (options.port) {
      this.port = options.port
    } else {
      const envPort = process.env.OVOGO_DAEMON_PORT
      this.port = envPort ? parseInt(envPort, 10) : 0
    }
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  isConfigured(): boolean {
    return this.port > 0
  }

  async send(req: DaemonRequest): Promise<DaemonResponse | DaemonEvent> {
    if (!this.isConfigured()) {
      throw new Error('DaemonClient: port not configured (set OVOGO_DAEMON_PORT or pass port)')
    }
    const response = await this.fetchImpl(`http://${this.host}:${this.port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    })
    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw new Error(`Daemon request failed: ${response.status} ${errText}`)
    }
    return (await response.json()) as DaemonResponse | DaemonEvent
  }
}
