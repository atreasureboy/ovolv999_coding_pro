/**
 * builtin command group 6/7 — split from builtin.ts (Round 29).
 * Registration is side-effectful: importing this file registers its commands.
 */

/*
 * Lazy-require pattern (inherited from builtin.ts): command handlers
 * require rarely-used modules at dispatch time to keep CLI startup lean.
 * The pattern is intentional; these rules would fire on every require.
 */
/* eslint-disable @typescript-eslint/consistent-type-imports */


import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
import { registerCommand } from '../index.js'
import type { WorkerEntry } from '../../core/daemon.js'
import type { DocSectionType } from '../../core/magicDocs.js'
import { resolve } from 'path'
import { readHiddenLine, text } from '../shared.js'

// ── /effort ─────────────────────────────────────────────────────────────────

registerCommand({
  name: 'effort',
  aliases: ['thinking'],
  description: 'Set reasoning effort level. Usage: /effort [minimal|low|medium|high|maximum]',
  handler: (args) => {
    const {
      setEffort, cycleEffort, getEffortPrompt, formatEffort, formatEffortList,
    } = require('../../core/effort.js') as typeof import('../../core/effort.js')

    const parts = args.trim().split(/\s+/)
    const level = parts[0]

    if (level === 'list' || level === 'ls') {
      return text(formatEffortList())
    }

    if (level === 'cycle' || level === 'next') {
      cycleEffort()
      return text(`Effort: ${formatEffort()}\n\nPrompt: ${getEffortPrompt()}`)
    }

    const validLevels = ['minimal', 'low', 'medium', 'high', 'maximum']
    if (validLevels.includes(level)) {
      setEffort(level as 'minimal' | 'low' | 'medium' | 'high' | 'maximum')
      return text(`Effort set to: ${formatEffort()}\n\nPrompt: ${getEffortPrompt()}`)
    }

    return text(`Unknown level: ${level}\n${formatEffortList()}`)
  },
})

// ── /team-memory ────────────────────────────────────────────────────────────

// ── /team-memory ────────────────────────────────────────────────────────────

registerCommand({
  name: 'team-memory',
  aliases: ['teammem'],
  description: 'Manage team memory sync. Usage: /team-memory [init <url> | status | sync | files | add <file> | enable-auto | disable-auto]',
  handler: (args, ctx) => {
    const teamMemModule = require('../../core/teamMemory.js') as typeof import('../../core/teamMemory.js')
    const {
      loadTeamConfig, saveTeamConfig, syncTeamMemory,
      findMemoryFiles, formatSyncResult, formatTeamMemoryStatus,
    } = teamMemModule

    const parts = args.trim().split(/\s+/)
    const sub = parts[0] ?? 'status'

    if (sub === 'init') {
      const url = parts[1]
      if (!url) return text('Usage: /team-memory init <git-remote-url>')
      const files = findMemoryFiles(ctx.cwd)
      saveTeamConfig({ remoteUrl: url, files, autoSync: false })
      return text(`Team memory initialized:\n  Remote: ${url}\n  Files: ${files.length > 0 ? files.join(', ') : '(none found)'}`)
    }

    if (sub === 'status') {
      return text(formatTeamMemoryStatus())
    }

    if (sub === 'sync') {
      const result = syncTeamMemory()
      return text(formatSyncResult(result))
    }

    if (sub === 'files') {
      const config = loadTeamConfig()
      if (!config) return text('Not configured. Use /team-memory init <url>')
      return text(config.files.length > 0 ? config.files.join('\n') : 'No files configured')
    }

    if (sub === 'add') {
      const file = parts[1]
      if (!file) return text('Usage: /team-memory add <file-path>')
      const config = loadTeamConfig() ?? { remoteUrl: '', files: [] }
      const resolved = resolve(ctx.cwd, file)
      if (!config.files.includes(resolved)) {
        config.files.push(resolved)
        saveTeamConfig(config)
      }
      return text(`Added: ${resolved}`)
    }

    return text(formatTeamMemoryStatus())
  },
})

// ── /vault ──────────────────────────────────────────────────────────────────

// ── /vault ──────────────────────────────────────────────────────────────────

registerCommand({
  name: 'vault',
  aliases: ['secrets', 'keychain'],
  description: 'Manage local vault. Usage: /vault [status | set <key> | get <key> | delete <key> | list]',
  handler: (args) => {
    const keychainModule = require('../../utils/keychain.js') as typeof import('../../utils/keychain.js')
    const { setSecret, getSecret, deleteSecret, listSecrets, getVaultMetadata, formatVaultStatus, getPassphraseFromEnv } = keychainModule

    const parts = args.trim().split(/\s+/)
    const sub = parts[0] ?? 'status'

    if (sub === 'status') {
      const pass = getPassphraseFromEnv()
      return text(formatVaultStatus(getVaultMetadata(pass)))
    }

    if (sub === 'set') {
      const key = parts[1]
      if (!key) return text('Usage: /vault set <key>')
      const pass = getPassphraseFromEnv()
      process.stdout.write(`Enter value for ${key}: `)
      let value: string
      try {
        value = readHiddenLine()
      } catch {
        return text('Failed to read value from stdin')
      }
      try {
        setSecret(key, value, pass ?? undefined)
        return text(`Stored: ${key}`)
      } catch (e) {
        return text(`Failed to store ${key}: ${(e as Error).message}`)
      }
    }

    if (sub === 'get') {
      const key = parts[1]
      if (!key) return text('Usage: /vault get <key>')
      const pass = getPassphraseFromEnv()
      try {
        const value = getSecret(key, pass ?? undefined)
        return text(value ? value : `Not found: ${key}`)
      } catch (e) {
        return text(`Failed to read vault: ${(e as Error).message}`)
      }
    }

    if (sub === 'delete') {
      const key = parts[1]
      if (!key) return text('Usage: /vault delete <key>')
      const pass = getPassphraseFromEnv()
      try {
        const deleted = deleteSecret(key, pass ?? undefined)
        return text(deleted ? `Deleted: ${key}` : `Not found: ${key}`)
      } catch (e) {
        return text(`Failed to read vault: ${(e as Error).message}`)
      }
    }

    if (sub === 'list') {
      const pass = getPassphraseFromEnv()
      try {
        const keys = listSecrets(pass ?? undefined)
        return text(keys.length > 0 ? keys.join('\n') : 'No secrets stored')
      } catch (e) {
        return text(`Failed to read vault: ${(e as Error).message}`)
      }
    }

    return text('Usage: /vault [status | set <key> | get <key> | delete <key> | list]')
  },
})

// ── /daemon ─────────────────────────────────────────────────────────────────

// ── /daemon ─────────────────────────────────────────────────────────────────

registerCommand({
  name: 'daemon',
  description: 'Daemon control. Usage: /daemon [status | workers | restart <id|all> | logs]',
  handler: async (args, ctx) => {
    const daemonModule = await import('../../core/daemon.js')
    const { isDaemonRunning, getDaemonSocketPath, getDaemonLogPath, formatDaemonInfo, formatWorkers, DaemonClient } = daemonModule
    const parts = args.trim().split(/\s+/)
    const sub = parts[0] ?? 'status'

    // status / workers / logs need a running daemon + live socket.
    if (!isDaemonRunning()) {
      return text('Daemon is not running. Start with: ovolv999 --daemon\nSocket: ' + getDaemonSocketPath() + '\nLog: ' + getDaemonLogPath())
    }

    // R13: route through DaemonClient so the slash command actually
    // talks to the long-running supervisor process. Uses the IPC
    // socket the daemon is listening on.
    const client = new DaemonClient(getDaemonSocketPath())

    if (sub === 'status') {
      const info = await client.status()
      if (!info) return text('Daemon reachable but status request failed.')
      return text(formatDaemonInfo(info))
    }

    if (sub === 'workers') {
      const res = await client.send({ action: 'list-workers' })
      if (!res.ok) return text('Failed to list workers: ' + (res.error ?? 'unknown'))
      // R40 changed the list-workers response to a {workers,total,offset,limit}
      // envelope. Unwrap the workers array before formatting.
      const wrapper = res.data as { workers: unknown[] }
      return text(formatWorkers(wrapper.workers as WorkerEntry[]))
    }

    if (sub === 'restart') {
      // R14: route restart-worker IPC action. The slash command
      // forwards the workerId into the daemon's payload, surfaces
      // the daemon's response (or error string) verbatim.
      // R16: bulk restart via workerId === 'all'.
      const workerId = parts[1]
      if (!workerId) return text('Usage: /daemon restart <workerId|all>')
      const res = await client.send({ action: 'restart-worker', payload: { workerId } })
      // R15: emit a worker_restart event to the engine's EventLog so
      // /trace can see daemon lifecycle events alongside permission
      // decisions. Best-effort — never fail the slash command on a
      // log failure.
      const eventLog = ctx.engine.getEventLog?.()
      eventLog?.append('worker_restart', 'daemon_slash', {
        workerId,
        outcome: res.ok ? 'requested' : 'failed',
        error: res.ok ? null : (res.error ?? 'unknown'),
        socketPath: getDaemonSocketPath(),
      })
      if (!res.ok) return text('Restart failed: ' + (res.error ?? 'unknown'))
      return text('Restart requested for ' + workerId + '.\n' + JSON.stringify(res.data, null, 2))
    }

    if (sub === 'logs') {
      const fs = await import('fs')
      const path = getDaemonLogPath()
      if (!fs.existsSync(path)) return text('No log file at ' + path)
      const content = fs.readFileSync(path, 'utf8')
      const lines = content.split('\n').slice(-30)
      return text('Last 30 log lines from ' + path + ':\n\n' + lines.join('\n'))
    }

    if (sub === 'start' || sub === 'stop') {
      return text('Inside a REPL, daemon ' + sub + ' is not delegated to the existing process.\nUse the CLI: ovolv999 daemon ' + sub)
    }

    return text('Usage: /daemon [status | workers | logs]')
  },
})

// ── /messages — inter-agent messaging ──────────────────────────────────────

// ── /messages — inter-agent messaging ──────────────────────────────────────

registerCommand({
  name: 'messages',
  aliases: ['msg'],
  description: 'Inter-agent messaging. Usage: /messages [agents | send <to> <msg> | list | stats]',
  handler: (args) => {
    const msgMod = require('../../core/messageBus.js') as typeof import('../../core/messageBus.js')
    const { getMessageBus, formatAgentList, formatMessageList, formatBusStats } = msgMod

    const parts = args.trim().split(/\s+/)
    const sub = parts[0] ?? 'stats'
    const bus = getMessageBus()

    if (sub === 'agents') {
      return text(formatAgentList(bus.listAgents()))
    }

    if (sub === 'list') {
      return text(formatMessageList(bus.getMessages()))
    }

    if (sub === 'stats') {
      return text(formatBusStats(bus.getStats()))
    }

    return text('Usage: /messages [agents | list | stats]')
  },
})

// ── /sandbox ────────────────────────────────────────────────────────────────

registerCommand({
  name: 'sandbox',
  description: 'Sandbox configuration. Usage: /sandbox [status | on | off | strict | standard | add-writable <path> | deny <path>]',
  handler: (args) => {
    const sandbox = require('../../core/sandbox.js') as typeof import('../../core/sandbox.js')
    const parts = args.trim().split(/\s+/)
    const sub = parts[0] ?? 'status'

    if (sub === 'status') {
      return text(sandbox.formatConfig(sandbox.loadConfig()) + '\n\n' + sandbox.formatProfile(sandbox.getCachedProfile(process.cwd())))
    }

    if (sub === 'on' || sub === 'enable') {
      const cfg = sandbox.updateConfig({ enabled: true })
      sandbox.invalidateProfileCache()
      return text('Sandbox enabled.\n' + sandbox.formatConfig(cfg))
    }

    if (sub === 'off' || sub === 'disable') {
      sandbox.updateConfig({ enabled: false })
      sandbox.invalidateProfileCache()
      return text('Sandbox disabled.')
    }

    if (sub === 'strict') {
      const cfg = sandbox.updateConfig({ enabled: true, level: 'strict', allowNetwork: false })
      sandbox.invalidateProfileCache()
      return text('Sandbox set to strict mode.\n' + sandbox.formatConfig(cfg))
    }

    if (sub === 'standard') {
      const cfg = sandbox.updateConfig({ enabled: true, level: 'standard', allowNetwork: true })
      sandbox.invalidateProfileCache()
      return text('Sandbox set to standard mode.\n' + sandbox.formatConfig(cfg))
    }

    if (sub === 'add-writable') {
      const path = parts[1]
      if (!path) return text('Usage: /sandbox add-writable <path>')
      const cfg = sandbox.loadConfig()
      cfg.writablePaths.push(path)
      sandbox.saveConfig(cfg)
      sandbox.invalidateProfileCache()
      return text(`Added writable path: ${path}`)
    }

    if (sub === 'deny') {
      const path = parts[1]
      if (!path) return text('Usage: /sandbox deny <path>')
      const cfg = sandbox.loadConfig()
      cfg.deniedPaths.push(path)
      sandbox.saveConfig(cfg)
      sandbox.invalidateProfileCache()
      return text(`Denied path: ${path}`)
    }

    return text(sandbox.formatConfig(sandbox.loadConfig()))
  },
})

// ── /sync ───────────────────────────────────────────────────────────────────

// ── /sync ───────────────────────────────────────────────────────────────────

registerCommand({
  name: 'sync',
  description: 'Settings sync. Usage: /sync [status | push-file <path> | pull-file <path> [passphrase] | push-git <repo> | pull-git <repo> [passphrase]]',
  handler: (args) => {
    const sync = require('../../core/settingsSync.js') as typeof import('../../core/settingsSync.js')
    const parts = args.trim().split(/\s+/)
    const sub = parts[0] ?? 'status'

    if (sub === 'status') {
      return text(sync.formatSyncStatus(sync.getSyncStatus()))
    }

    if (sub === 'push-file') {
      const filePath = parts[1]
      if (!filePath) return text('Usage: /sync push-file <path> [passphrase]')
      const passphrase = parts[2]
      const result = sync.syncPush({ transport: 'file', filePath, passphrase })
      return text(sync.formatSyncResult(result))
    }

    if (sub === 'pull-file') {
      const filePath = parts[1]
      if (!filePath) return text('Usage: /sync pull-file <path> [passphrase]')
      const passphrase = parts[2]
      const result = sync.syncPull({ transport: 'file', filePath, passphrase, force: parts.includes('--force') })
      return text(sync.formatSyncResult(result))
    }

    if (sub === 'push-git') {
      const repo = parts[1]
      if (!repo) return text('Usage: /sync push-git <repo> [passphrase]')
      const passphrase = parts[2]
      const result = sync.syncPush({ transport: 'git', repo, passphrase })
      return text(sync.formatSyncResult(result))
    }

    if (sub === 'pull-git') {
      const repo = parts[1]
      if (!repo) return text('Usage: /sync pull-git <repo> [passphrase]')
      const passphrase = parts[2]
      const result = sync.syncPull({ transport: 'git', repo, passphrase, force: parts.includes('--force') })
      return text(sync.formatSyncResult(result))
    }

    return text(sync.formatSyncStatus(sync.getSyncStatus()))
  },
})

// ── /telemetry ──────────────────────────────────────────────────────────────

// ── /telemetry ──────────────────────────────────────────────────────────────

registerCommand({
  name: 'telemetry',
  description: 'Usage analytics. Usage: /telemetry [stats | on | off | export | clear]',
  handler: (args) => {
    const tel = require('../../core/telemetry.js') as typeof import('../../core/telemetry.js')
    const parts = args.trim().split(/\s+/)
    const sub = parts[0] ?? 'stats'

    if (sub === 'stats') {
      return text(tel.formatAggregates(tel.getAggregates()))
    }

    if (sub === 'on') {
      const cfg = tel.setEnabled(true)
      return text(tel.formatConfig(cfg))
    }

    if (sub === 'off') {
      const cfg = tel.setEnabled(false)
      return text(tel.formatConfig(cfg))
    }

    if (sub === 'export') {
      const data = tel.exportData()
      return text(JSON.stringify(data.aggregates, null, 2))
    }

    if (sub === 'clear') {
      const n = tel.clearData()
      return text(`Cleared ${n} telemetry events.`)
    }

    return text(tel.formatConfig(tel.loadConfig()))
  },
})

// ── /magic-docs ─────────────────────────────────────────────────────────────

// ── /magic-docs ─────────────────────────────────────────────────────────────

registerCommand({
  name: 'magic-docs',
  aliases: ['mdocs'],
  description: 'Extract project documentation. Usage: /magic-docs [write | <section>]',
  handler: (args) => {
    const md = require('../../core/magicDocs.js') as typeof import('../../core/magicDocs.js')
    const parts = args.trim().split(/\s+/)
    const sub = parts[0] ?? 'preview'

    const rootDir = process.cwd()

    if (sub === 'write') {
      const outputPath = parts[1] ?? `${rootDir}/.ovolv999/magic-docs.md`
      const result = md.extractDocs({ rootDir, outputPath })
      return text(md.formatResult(result) + `\n\nWritten to ${outputPath}`)
    }

    if (sub === 'preview' || !sub) {
      const result = md.extractDocs({ rootDir })
      return text(md.formatResult(result))
    }

    // Specific section
    const result = md.extractDocs({ rootDir, sections: [sub as DocSectionType] })
    if (result.sections.length === 0) {
      return text(`Unknown section: ${sub}. Available: overview, api, models, config, decisions, patterns, dependencies`)
    }
    return text(md.formatSection(result.sections[0]))
  },
})

// ── /ssh ────────────────────────────────────────────────────────────────────

// ── /ssh ────────────────────────────────────────────────────────────────────

registerCommand({
  name: 'ssh',
  description: 'SSH remote profiles. Usage: /ssh [list | add <name> <host> [user] [port] | remove <name> | test <name> | run <name> <command>]',
  handler: (args) => {
    const ssh = require('../../core/sshRemote.js') as typeof import('../../core/sshRemote.js')
    const parts = args.trim().split(/\s+/)
    const sub = parts[0] ?? 'list'

    if (sub === 'list') {
      return text(ssh.formatProfileList(ssh.loadProfiles()))
    }

    if (sub === 'add') {
      const name = parts[1]
      const host = parts[2]
      if (!name || !host) return text('Usage: /ssh add <name> <host> [user] [port]')
      const profile = {
        name, host,
        user: parts[3] || undefined,
        port: parts[4] ? parseInt(parts[4], 10) : undefined,
      }
      ssh.addProfile(profile)
      return text(`Added SSH profile: ${name}\n` + ssh.formatProfile(profile))
    }

    if (sub === 'remove') {
      const name = parts[1]
      if (!name) return text('Usage: /ssh remove <name>')
      const ok = ssh.removeProfile(name)
      return text(ok ? `Removed ${name}` : `Not found: ${name}`)
    }

    if (sub === 'test') {
      const name = parts[1]
      if (!name) return text('Usage: /ssh test <name>')
      const profile = ssh.getProfile(name)
      if (!profile) return text(`Profile not found: ${name}`)
      const result = ssh.testConnection(profile)
      return text(ssh.formatConnectionTest(result))
    }

    if (sub === 'run') {
      const name = parts[1]
      const cmd = parts.slice(2).join(' ')
      if (!name || !cmd) return text('Usage: /ssh run <name> <command>')
      const profile = ssh.getProfile(name)
      if (!profile) return text(`Profile not found: ${name}`)
      const result = ssh.execRemote(profile, cmd)
      return text(ssh.formatExecResult(result))
    }

    return text(ssh.formatProfileList(ssh.loadProfiles()))
  },
})

// ── /lsp ────────────────────────────────────────────────────────────────────

// ── /lsp ────────────────────────────────────────────────────────────────────

registerCommand({
  name: 'lsp',
  description: 'Language server status. Usage: /lsp [status | symbols <query>]',
  handler: async (args) => {
    const lsp = require('../../core/lsp/client.js') as typeof import('../../core/lsp/client.js')
    const parts = args.trim().split(/\s+/)
    const sub = parts[0] ?? 'status'

    if (sub === 'status') {
      const spec = lsp.detectServer('typescript')
      const lines = ['LSP Status:']
      lines.push(`  Detected server: ${spec ? spec.command : 'none'}`)
      lines.push(`  Default client running: ${lsp.getDefaultLspClient(lsp.pathToFileUri(process.cwd())).isRunning() ? 'yes' : 'no'}`)
      return text(lines.join('\n'))
    }

    if (sub === 'symbols') {
      const query = parts.slice(1).join(' ')
      if (!query) return text('Usage: /lsp symbols <query>')
      const client = lsp.getDefaultLspClient(lsp.pathToFileUri(process.cwd()))
      if (!client.isRunning()) {
        const started = await client.start()
        if (!started) return text('LSP server not available')
      }
      const symbols = await client.workspaceSymbols(query)
      if (symbols.length === 0) return text('No symbols found.')
      const lines = [`Found ${symbols.length} symbol(s):`]
      for (const s of symbols.slice(0, 30)) {
        lines.push(`  ${s.name} (kind ${s.kind}) — ${s.location.uri}`)
      }
      return text(lines.join('\n'))
    }

    return text('Usage: /lsp [status | symbols <query>]')
  },
})

// ── /update ─────────────────────────────────────────────────────────────────

// ── /update ─────────────────────────────────────────────────────────────────

registerCommand({
  name: 'update',
  description: 'Check for ovolv999 updates. Usage: /update [check | ignore <version> | install [beta]]',
  handler: (args) => {
    const upd = require('../../utils/autoUpdater.js') as typeof import('../../utils/autoUpdater.js')
    const parts = args.trim().split(/\s+/)
    const sub = parts[0] ?? 'check'

    if (sub === 'check') {
      const cached = upd.getCachedCheck()
      if (cached) return text(upd.formatUpdateCheckResult(cached) + '\n(cached)')
      const result = upd.checkForUpdates()
      upd.setCachedCheck(result)
      return text(upd.formatUpdateCheckResult(result))
    }

    if (sub === 'ignore') {
      const version = parts[1]
      if (!version) return text('Usage: /update ignore <version>')
      upd.ignoreVersion(version)
      return text(`Ignoring version ${version}`)
    }

    if (sub === 'install') {
      const requested = parts[1]
      const CHANNELS = ['latest', 'beta', 'next'] as const
      const channel = CHANNELS.find((c) => c === requested)
      if (requested && !channel) {
        return text(`Unknown channel "${requested}". Channels: ${CHANNELS.join(', ')}`)
      }
      const result = upd.performUpdate(channel ?? 'latest')
      return text(result.message)
    }

    return text('Usage: /update [check | ignore <version> | install [beta]]')
  },
})

// ── /cache ──────────────────────────────────────────────────────────────────
