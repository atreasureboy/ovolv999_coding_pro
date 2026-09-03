/**
 * LSP servers spawned by the lsp tool (or FileRead warmup) were never
 * stopped: nothing called shutdownDefaultLspClient and the shared
 * registry outlived engine dispose, leaving tsserver/pyright processes
 * running after the CLI exited. engineAssembly.dispose() now sweeps the
 * registry via shutdownAllLspServers().
 *
 * These tests verify the two halves of that contract: stop() actually
 * kills a live child process, and the sweep stops every registered
 * client and leaves the registry clean (in-flight spawns settle first).
 */
import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { LspClient } from '../src/core/lsp/client.js'
import { shutdownAllLspServers, _lspRegistryForTests, _resetLspToolCaches } from '../src/tools/lspTool.js'

interface RegistryEntry {
  client: { stop: () => Promise<void> }
  initializedFor: Set<string>
}

function registry(): Map<string, RegistryEntry> {
  return _lspRegistryForTests() as unknown as Map<string, RegistryEntry>
}

describe('LSP shutdown', () => {
  it('stop() kills a live child process', async () => {
    const client = new LspClient({ command: 'cat' })
    // Inject a real live child + a minimal connection so stop() takes the
    // "send shutdown, then kill" path without an LSP handshake.
    const proc = spawn('cat', [], { stdio: 'pipe' })
    ;(client as unknown as { proc: unknown }).proc = proc
    ;(client as unknown as { connection: unknown }).connection = {
      sendRequest: async () => ({}),
      sendNotification: async () => {},
    }
    ;(client as unknown as { started: boolean }).started = true
    expect(proc.killed).toBe(false)
    await client.stop()
    expect(proc.killed).toBe(true)
    await Promise.race([once(proc, 'exit'), new Promise((r) => setTimeout(r, 2_000))])
  })

  it('the sweep stops every registered client and clears the registry', async () => {
    _resetLspToolCaches()
    registry().clear()
    const stopped: string[] = []
    for (const key of ['a::tsserver', 'b::pyright']) {
      registry().set(key, {
        client: { stop: async () => { stopped.push(key) } },
        initializedFor: new Set(['a', 'b']),
      })
    }
    await shutdownAllLspServers()
    expect(stopped.sort()).toEqual(['a::tsserver', 'b::pyright'])
    expect(registry().size).toBe(0)
  })

  it('the sweep is a no-op on an empty registry', async () => {
    _resetLspToolCaches()
    registry().clear()
    await expect(shutdownAllLspServers()).resolves.toBeUndefined()
    expect(registry().size).toBe(0)
  })
})
