/**
 * Hooks System
 *
 * User-configurable shell command hooks that fire at specific lifecycle
 * events. Inspired by claude-code's hook system.
 *
 * Events:
 *   - PreToolUse    : before a tool executes (can block/modify)
 *   - PostToolUse   : after a tool executes (can inspect result)
 *   - UserPromptSubmit : when user submits a prompt
 *   - SessionStart  : when a session begins
 *   - SessionEnd    : when a session ends
 *   - Notification  : when a notification is sent
 *
 * Hook config example (in config.json):
 *   {
 *     "hooks": {
 *       "PreToolUse": [
 *         { "matcher": "Bash", "command": "echo 'about to run bash'" }
 *       ],
 *       "PostToolUse": [
 *         { "matcher": "Write", "command": "npx prettier --write $TOOL_INPUT_PATH" }
 *       ]
 *     }
 *   }
 */

import { execSync, type ExecSyncOptions } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// ── Types ───────────────────────────────────────────────────────────────────

export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Notification'

export interface HookConfig {
  /** Tool name matcher (glob pattern). Use '*' to match all. */
  matcher: string
  /** Shell command to execute */
  command: string
  /** Timeout in ms (default: 60000) */
  timeout?: number
}

export type HooksConfig = Partial<Record<HookEvent, HookConfig[]>>

export interface HookContext {
  event: HookEvent
  /** Tool name (for tool events) */
  toolName?: string
  /** Tool input as JSON string */
  toolInput?: Record<string, unknown>
  /** Tool output (PostToolUse only) */
  toolOutput?: string
  /** User prompt (UserPromptSubmit only) */
  prompt?: string
  /** Session ID */
  sessionId?: string
  /** Working directory */
  cwd: string
}

export interface HookResult {
  /** Whether the hook allows the action to proceed */
  allowed: boolean
  /** Whether the hook command ran successfully */
  success: boolean
  /** Stdout from the hook command */
  stdout: string
  /** Stderr from the hook command */
  stderr: string
  /** Exit code */
  exitCode: number | null
  /** Reason for blocking (if allowed=false) */
  blockReason?: string
  /** Duration in ms */
  duration: number
}

// ── Matcher ─────────────────────────────────────────────────────────────────

/**
 * Match a tool name against a hook matcher pattern.
 * Supports:
 *   - '*' matches all tools
 *   - 'Bash' matches exactly
 *   - 'Bash|Read' alternation
 *   - 'Bash(git *)' matches Bash tool with input matching 'git *'
 */
export function matchHook(matcher: string, toolName: string, toolInput?: Record<string, unknown>): boolean {
  if (matcher === '*' || matcher === '') return true

  // Handle Tool(inputPattern) syntax
  const parenMatch = matcher.match(/^(\w+(?:\|\w+)*)\((.*)\)$/)
  if (parenMatch) {
    const [, toolPattern, inputPattern] = parenMatch
    if (!matchToolNames(toolPattern, toolName)) return false
    if (!inputPattern) return true
    return matchInputPattern(inputPattern, toolInput)
  }

  return matchToolNames(matcher, toolName)
}

function matchToolNames(pattern: string, toolName: string): boolean {
  if (pattern === '*') return true
  const names = pattern.split('|').map(s => s.trim())
  return names.includes(toolName)
}

function matchInputPattern(pattern: string, toolInput?: Record<string, unknown>): boolean {
  if (!toolInput) return false
  // Convert glob to regex: '*' → '.*', '?' → '.'
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  const regex = new RegExp(`^${regexStr}`, 'i')

  // Check against common input fields
  const candidates = [
    toolInput.command,
    toolInput.filePath,
    toolInput.path,
    toolInput.pattern,
    JSON.stringify(toolInput),
  ].filter(Boolean)

  return candidates.some(c => regex.test(String(c)))
}

// ── Hook Execution ──────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT = 60000

export function runHook(
  hook: HookConfig,
  context: HookContext,
): HookResult {
  const start = Date.now()

  const env: Record<string, string> = {
    HOOK_EVENT: context.event,
    TOOL_NAME: context.toolName ?? '',
    TOOL_INPUT: context.toolInput ? JSON.stringify(context.toolInput) : '',
    TOOL_OUTPUT: (context.toolOutput ?? '').slice(0, 10000),
    PROMPT: (context.prompt ?? '').slice(0, 10000),
    SESSION_ID: context.sessionId ?? '',
    HOOK_CWD: context.cwd,
  }

  // Also expose specific fields
  if (context.toolInput) {
    for (const [k, v] of Object.entries(context.toolInput)) {
      const envKey = `TOOL_INPUT_${k.toUpperCase()}`
      env[envKey] = typeof v === 'string' ? v : JSON.stringify(v)
    }
  }

  const options: ExecSyncOptions = {
    cwd: context.cwd,
    env: { ...process.env, ...env },
    timeout: hook.timeout ?? DEFAULT_TIMEOUT,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }

  try {
    const stdout = execSync(hook.command, options) ?? ''
    const duration = Date.now() - start
    return {
      allowed: true,
      success: true,
      stdout: stdout.toString(),
      stderr: '',
      exitCode: 0,
      duration,
    }
  } catch (err: unknown) {
    const duration = Date.now() - start
    const e = err as { stdout?: string; stderr?: string; status?: number; killed?: boolean; signal?: string }
    const stdout = (e.stdout ?? '').toString()
    const stderr = (e.stderr ?? '').toString()
    const killed = e.killed || (e.signal === 'SIGTERM')
    const exitCode = e.status ?? null

    // Exit code 2 = block the action
    if (exitCode === 2) {
      return {
        allowed: false,
        success: false,
        stdout,
        stderr,
        exitCode,
        duration,
        blockReason: stderr.trim() || stdout.trim() || 'Hook blocked the action (exit code 2)',
      }
    }

    return {
      allowed: !killed,
      success: false,
      stdout,
      stderr,
      exitCode,
      duration,
      blockReason: killed ? `Hook timed out after ${hook.timeout ?? DEFAULT_TIMEOUT}ms` : undefined,
    }
  }
}

export function runHooks(
  hooks: HookConfig[],
  context: HookContext,
): HookResult[] {
  const results: HookResult[] = []
  for (const hook of hooks) {
    if (!matchHook(hook.matcher, context.toolName ?? '', context.toolInput)) continue
    results.push(runHook(hook, context))
  }
  return results
}

/**
 * Run all hooks for an event. Returns aggregated result.
 * For PreToolUse: if any hook returns allowed=false, the action is blocked.
 */
export function runEventHooks(
  config: HooksConfig,
  event: HookEvent,
  context: HookContext,
): HookResult[] {
  const hooks = config[event]
  if (!hooks || hooks.length === 0) return []
  return runHooks(hooks, { ...context, event })
}

/**
 * Check if PreToolUse hooks allow a tool call.
 * Returns { allowed, reasons }.
 */
export function checkPreToolUse(
  config: HooksConfig,
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd: string,
): { allowed: boolean; reasons: string[]; results: HookResult[] } {
  const results = runEventHooks(config, 'PreToolUse', {
    event: 'PreToolUse',
    toolName,
    toolInput,
    cwd,
  })

  const reasons: string[] = []
  for (const r of results) {
    if (!r.allowed && r.blockReason) reasons.push(r.blockReason)
  }

  return { allowed: reasons.length === 0, reasons, results }
}

// ── Config Persistence ──────────────────────────────────────────────────────

export function getHooksConfigPath(): string {
  return join(homedir(), '.ovolv999', 'hooks.json')
}

export function loadHooksConfig(): HooksConfig {
  const path = getHooksConfigPath()
  if (!existsSync(path)) return {}
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return validateHooksConfig(parsed)
  } catch {
    return {}
  }
}

export function saveHooksConfig(config: HooksConfig): void {
  const path = getHooksConfigPath()
  const dir = join(path, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2))
}

export function validateHooksConfig(data: unknown): HooksConfig {
  if (typeof data !== 'object' || data === null) return {}
  const obj = data as Record<string, unknown>
  const valid: HooksConfig = {}
  const validEvents: HookEvent[] = [
    'PreToolUse', 'PostToolUse', 'UserPromptSubmit',
    'SessionStart', 'SessionEnd', 'Notification',
  ]
  for (const event of validEvents) {
    if (Array.isArray(obj[event])) {
      valid[event] = (obj[event] as unknown[])
        .filter((h): h is HookConfig => typeof h === 'object' && h !== null && typeof (h as HookConfig).command === 'string')
        .map(h => ({
          matcher: typeof h.matcher === 'string' ? h.matcher : '*',
          command: h.command,
          timeout: typeof h.timeout === 'number' ? h.timeout : undefined,
        }))
    }
  }
  return valid
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatHooksConfig(config: HooksConfig): string {
  const events = Object.keys(config) as HookEvent[]
  if (events.length === 0) return 'No hooks configured.'

  const lines: string[] = ['Hooks Configuration:']
  for (const event of events) {
    const hooks = config[event]
    if (!hooks || hooks.length === 0) continue
    lines.push(`\n${event}:`)
    for (const hook of hooks) {
      const timeout = hook.timeout ? ` (timeout: ${hook.timeout}ms)` : ''
      lines.push(`  [${hook.matcher}] ${hook.command}${timeout}`)
    }
  }
  return lines.join('\n')
}

export function formatHookResult(result: HookResult): string {
  const status = result.allowed ? '✓' : '✗ BLOCKED'
  const parts = [`${status} (${result.duration}ms)`]
  if (result.exitCode !== null) parts.push(`exit: ${result.exitCode}`)
  if (result.stdout.trim()) parts.push(`stdout: ${result.stdout.trim().slice(0, 200)}`)
  if (result.stderr.trim()) parts.push(`stderr: ${result.stderr.trim().slice(0, 200)}`)
  if (result.blockReason) parts.push(`reason: ${result.blockReason}`)
  return parts.join('\n  ')
}
