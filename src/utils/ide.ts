/**
 * IDE Detection & Integration
 *
 * Detects running IDEs (VS Code, Cursor, Windsurf, JetBrains, Neovim)
 * via env vars and lockfiles. Provides open-file and diff launching.
 */

import { existsSync, readFileSync } from 'fs'
import { join, resolve, isAbsolute } from 'path'
import { execSync } from 'child_process'

// ── Types ───────────────────────────────────────────────────────────────────

export type IDEType =
  | 'vscode'
  | 'cursor'
  | 'windsurf'
  | 'intellij'
  | 'webstorm'
  | 'pycharm'
  | 'goland'
  | 'phpstorm'
  | 'rubymine'
  | 'rustrover'
  | 'clion'
  | 'neovim'
  | 'vim'
  | 'emacs'
  | 'sublime'
  | 'atom'
  | 'zed'
  | 'unknown'

export interface IDEInfo {
  type: IDEType
  name: string
  version?: string
  /** Workspace root if detectable */
  workspace?: string
  /** Whether this IDE is currently running (we're inside it) */
  running: boolean
  /** Path to the IDE executable for launching */
  executable?: string
  /** How it was detected */
  detectionSource: 'env' | 'lockfile' | 'process' | 'fallback'
}

// ── Detection ───────────────────────────────────────────────────────────────

const ENV_INDICATORS: Array<{ env: string; value?: string; type: IDEType; name: string }> = [
  { env: 'VSCODE_IPC_HOOK_CLI', type: 'vscode', name: 'VS Code' },
  { env: 'VSCODE_GIT_IPC_HANDLE', type: 'vscode', name: 'VS Code' },
  { env: 'CURSOR_IPC_HOOK_CLI', type: 'cursor', name: 'Cursor' },
  { env: 'WINDSURF_IPC_HOOK_CLI', type: 'windsurf', name: 'Windsurf' },
  { env: 'TERMINAL_EMULATOR', value: 'JetBrains', type: 'intellij', name: 'IntelliJ' },
  { env: 'INTELLIJ_ENVIRONMENT_READER', type: 'intellij', name: 'IntelliJ' },
  { env: 'NVIM', type: 'neovim', name: 'Neovim' },
  { env: 'VIM', type: 'vim', name: 'Vim' },
  { env: 'INSIDE_EMACS', type: 'emacs', name: 'Emacs' },
  { env: 'SUBLIME_VERSION', type: 'sublime', name: 'Sublime Text' },
  { env: 'ATOM_HOME', type: 'atom', name: 'Atom' },
]

export function detectIDE(): IDEInfo | null {
  // 1. Check env vars (most reliable)
  for (const indicator of ENV_INDICATORS) {
    const value = process.env[indicator.env]
    if (value && (!indicator.value || value.includes(indicator.value))) {
      const workspace = detectWorkspaceFromEnv(indicator.type)
      return {
        type: indicator.type,
        name: indicator.name,
        workspace,
        running: true,
        detectionSource: 'env',
        executable: findIdeExecutable(indicator.type),
      }
    }
  }

  // 2. Check TERM_PROGRAM
  const termProgram = process.env.TERM_PROGRAM ?? ''
  if (termProgram === 'vscode') {
    return { type: 'vscode', name: 'VS Code', running: true, detectionSource: 'env', workspace: process.env.VSCODE_CWD }
  }
  if (termProgram === 'Cursor') {
    return { type: 'cursor', name: 'Cursor', running: true, detectionSource: 'env' }
  }
  if (termProgram === 'Windsurf') {
    return { type: 'windsurf', name: 'Windsurf', running: true, detectionSource: 'env' }
  }

  // 3. Check for IDE lockfiles in workspace
  const cwd = process.cwd()
  const lockfileIde = detectFromLockfiles(cwd)
  if (lockfileIde) {
    return { ...lockfileIde, running: false, detectionSource: 'lockfile' }
  }

  return null
}

function detectWorkspaceFromEnv(type: IDEType): string | undefined {
  if (type === 'vscode' || type === 'cursor' || type === 'windsurf') {
    return process.env.VSCODE_CWD ?? process.env.PWD ?? process.cwd()
  }
  if (type === 'intellij' || type === 'webstorm') {
    return process.env.INTELLIJ_PROJECT_DIR ?? process.env.PWD
  }
  return undefined
}

// ── Lockfile Detection ──────────────────────────────────────────────────────

interface LockfileResult {
  type: IDEType
  name: string
  workspace: string
  executable?: string
}

function detectFromLockfiles(dir: string): LockfileResult | null {
  // VS Code: .vscode/ directory
  if (existsSync(join(dir, '.vscode'))) {
    return { type: 'vscode', name: 'VS Code', workspace: dir }
  }
  // Cursor: .cursor/ directory
  if (existsSync(join(dir, '.cursor'))) {
    return { type: 'cursor', name: 'Cursor', workspace: dir }
  }
  // Windsurf: .windsurf/ directory
  if (existsSync(join(dir, '.windsurf'))) {
    return { type: 'windsurf', name: 'Windsurf', workspace: dir }
  }
  // IntelliJ: .idea/ directory
  if (existsSync(join(dir, '.idea'))) {
    return { type: 'intellij', name: 'IntelliJ IDEA', workspace: dir }
  }
  return null
}

// ── Executable Discovery ────────────────────────────────────────────────────

function findIdeExecutable(type: IDEType): string | undefined {
  const commands: Record<string, string[]> = {
    vscode: ['code', 'code-insiders'],
    cursor: ['cursor'],
    windsurf: ['windsurf'],
    intellij: ['idea'],
    webstorm: ['webstorm'],
    pycharm: ['pycharm'],
    goland: ['goland'],
    phpstorm: ['phpstorm'],
    rubymine: ['rubymine'],
    rustrover: ['rustrover'],
    clion: ['clion'],
    neovim: ['nvim'],
    vim: ['vim'],
    emacs: ['emacs'],
    sublime: ['subl'],
    atom: ['atom'],
    zed: ['zeditor', 'zed'],
  }

  const cmds = commands[type]
  if (!cmds) return undefined

  for (const cmd of cmds) {
    try {
      const path = execSync(`which ${cmd} 2>/dev/null || where ${cmd} 2>nul`, {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()
      if (path) return path
    } catch { /* not found */ }
  }

  return undefined
}

// ── Launch Operations ───────────────────────────────────────────────────────

export function openInIDE(
  filePath: string,
  options: { line?: number; column?: number; ide?: IDEType; cwd?: string } = {},
): { success: boolean; message: string; command?: string } {
  const ide = options.ide ?? detectIDE()?.type
  if (!ide) {
    return { success: false, message: 'No IDE detected. Install VS Code/Cursor or set $EDITOR.' }
  }

  const absPath = isAbsolute(filePath) ? filePath : resolve(options.cwd ?? process.cwd(), filePath)
  if (!existsSync(absPath)) {
    return { success: false, message: `File not found: ${absPath}` }
  }

  const position = options.line
    ? `:${options.line}${options.column ? `:${options.column}` : ''}`
    : ''

  const cmds: Record<string, string> = {
    vscode: `code "${absPath}${position}"`,
    cursor: `cursor "${absPath}${position}"`,
    windsurf: `windsurf "${absPath}${position}"`,
    intellij: `idea "${absPath}${position ? `:${options.line}` : ''}"`,
    webstorm: `webstorm "${absPath}${position ? `:${options.line}` : ''}"`,
    pycharm: `pycharm "${absPath}${position ? `:${options.line}` : ''}"`,
    goland: `goland "${absPath}${position ? `:${options.line}` : ''}"`,
    sublime: `subl "${absPath}${position}"`,
    neovim: `nvim "${absPath}${position ? ` +${options.line}` : ''}"`,
    vim: `vim "${absPath}${position ? ` +${options.line}` : ''}"`,
    emacs: `emacs "${absPath}${position ? ` +${options.line}:${options.column ?? 1}` : ''}"`,
    zed: `zeditor "${absPath}${position}"`,
  }

  const cmd = cmds[ide]
  if (!cmd) {
    return { success: false, message: `Opening files in ${ide} not supported` }
  }

  try {
    execSync(cmd, { stdio: 'pipe', timeout: 5000 })
    return { success: true, message: `Opened in ${ide}`, command: cmd }
  } catch (err) {
    return {
      success: false,
      message: `Failed to open: ${err instanceof Error ? err.message : String(err)}`,
      command: cmd,
    }
  }
}

export function openDiffInIDE(
  oldPath: string,
  newPath: string,
  options: { ide?: IDEType; cwd?: string } = {},
): { success: boolean; message: string; command?: string } {
  const ide = options.ide ?? detectIDE()?.type
  if (!ide) {
    return { success: false, message: 'No IDE detected' }
  }

  const cwd = options.cwd ?? process.cwd()
  const oldAbs = isAbsolute(oldPath) ? oldPath : resolve(cwd, oldPath)
  const newAbs = isAbsolute(newPath) ? newPath : resolve(cwd, newPath)

  const cmds: Record<string, string> = {
    vscode: `code --diff "${oldAbs}" "${newAbs}"`,
    cursor: `cursor --diff "${oldAbs}" "${newAbs}"`,
    windsurf: `windsurf --diff "${oldAbs}" "${newAbs}"`,
  }

  const cmd = cmds[ide]
  if (!cmd) {
    return { success: false, message: `Diff view not supported in ${ide}` }
  }

  try {
    execSync(cmd, { stdio: 'pipe', timeout: 5000 })
    return { success: true, message: `Opened diff in ${ide}`, command: cmd }
  } catch (err) {
    return {
      success: false,
      message: `Failed to open diff: ${err instanceof Error ? err.message : String(err)}`,
      command: cmd,
    }
  }
}

// ── IDE Lockfile Management ─────────────────────────────────────────────────

export interface IDELockfile {
  ide: IDEType
  pid: number
  fd: number
  createdAt: string
}

export function readVSCodeLockfile(cwd: string): IDELockfile | null {
  const lockfile = join(cwd, '.vscode', '.vscode-lock')
  if (!existsSync(lockfile)) return null
  try {
    const content = readFileSync(lockfile, 'utf8')
    const parts = content.split('\n')
    return {
      ide: 'vscode',
      pid: parseInt(parts[0] ?? '0', 10),
      fd: parseInt(parts[1] ?? '0', 10),
      createdAt: parts[2] ?? new Date().toISOString(),
    }
  } catch {
    return null
  }
}

// ── Path Conversion ─────────────────────────────────────────────────────────

export function convertPathForIDE(path: string, ide: IDEType): string {
  // VS Code/Cursor/Windsurf use forward slashes everywhere
  if (['vscode', 'cursor', 'windsurf'].includes(ide)) {
    return path.replace(/\\/g, '/')
  }
  return path
}

// ── Extension Recommendations ───────────────────────────────────────────────

export interface ExtensionRecommendation {
  id: string
  name: string
  reason: string
  required: boolean
}

export function getExtensionRecommendations(ide: IDEType): ExtensionRecommendation[] {
  const recommendations: ExtensionRecommendation[] = []

  if (ide === 'vscode' || ide === 'cursor' || ide === 'windsurf') {
    recommendations.push(
      { id: 'esbenp.prettier-vscode', name: 'Prettier', reason: 'Code formatting', required: false },
      { id: 'dbaeumer.vscode-eslint', name: 'ESLint', reason: 'JavaScript linting', required: false },
    )
  }

  return recommendations
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatIDEInfo(info: IDEInfo): string {
  const lines: string[] = [
    `IDE: ${info.name}`,
    `  Type: ${info.type}`,
    `  Running: ${info.running ? '✓' : '✗'}`,
    `  Detection: ${info.detectionSource}`,
  ]
  if (info.version) lines.push(`  Version: ${info.version}`)
  if (info.workspace) lines.push(`  Workspace: ${info.workspace}`)
  if (info.executable) lines.push(`  Executable: ${info.executable}`)
  return lines.join('\n')
}

export function listAllKnownIDEs(): Array<{ type: IDEType; name: string }> {
  return [
    { type: 'vscode', name: 'VS Code' },
    { type: 'cursor', name: 'Cursor' },
    { type: 'windsurf', name: 'Windsurf' },
    { type: 'intellij', name: 'IntelliJ IDEA' },
    { type: 'webstorm', name: 'WebStorm' },
    { type: 'pycharm', name: 'PyCharm' },
    { type: 'goland', name: 'GoLand' },
    { type: 'rustrover', name: 'RustRover' },
    { type: 'neovim', name: 'Neovim' },
    { type: 'vim', name: 'Vim' },
    { type: 'emacs', name: 'Emacs' },
    { type: 'sublime', name: 'Sublime Text' },
    { type: 'zed', name: 'Zed' },
  ]
}
