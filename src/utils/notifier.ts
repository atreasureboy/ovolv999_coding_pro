/**
 * Cross-Platform Notifier
 *
 * Sends desktop/terminal notifications when long-running tasks complete.
 * Supports multiple channels with auto-detection:
 *   - macOS notification center (osascript)
 *   - Linux libnotify (notify-send)
 *   - Windows toast (powershell)
 *   - terminal bell (\x07)
 *   - iTerm2 proprietary escape sequences
 *   - kitty terminal notifications
 */

import { execFileSync, type ExecFileSyncOptions } from 'child_process'

// ── Types ───────────────────────────────────────────────────────────────────

export type NotificationChannel =
  | 'macos'
  | 'linux'
  | 'windows'
  | 'iterm2'
  | 'kitty'
  | 'bell'
  | 'auto'

export interface NotificationOptions {
  title: string
  body: string
  /** Which channel to use (default: auto-detect) */
  channel?: NotificationChannel
  /** Sound (platform-specific) */
  sound?: boolean
  /** Subtitle (macOS only) */
  subtitle?: string
}

export interface NotifyResult {
  channel: NotificationChannel
  success: boolean
  error?: string
}

// ── Platform Detection ──────────────────────────────────────────────────────

export function detectPlatform(): NodeJS.Platform {
  return process.platform
}

/**
 * Detect the best notification channel for the current environment.
 * Checks platform AND terminal-specific env vars.
 */
export function detectBestChannel(): NotificationChannel {
  const term = process.env.TERM_PROGRAM ?? ''

  // iTerm2
  if (term === 'iTerm.app' || process.env.ITERM_SESSION_ID) {
    return 'iterm2'
  }
  // kitty
  if (term === 'kitty' || process.env.KITTY_WINDOW_ID) {
    return 'kitty'
  }

  // Platform defaults
  switch (process.platform) {
    case 'darwin': return 'macos'
    case 'linux': return 'linux'
    default: return 'bell'
  }
}

/**
 * Check if a notification channel is available on this system.
 */
export function isChannelAvailable(channel: NotificationChannel): boolean {
  switch (channel) {
    case 'bell': return true
    case 'iterm2': return Boolean(process.env.ITERM_SESSION_ID)
    case 'kitty': return Boolean(process.env.KITTY_WINDOW_ID)
    case 'macos': return process.platform === 'darwin'
    case 'linux':
      try {
        execFileSync('which', ['notify-send'], { stdio: 'pipe' })
        return true
      } catch { return false }
    case 'windows': return process.platform === 'win32'
    case 'auto': return true
    default: return false
  }
}

// ── Channel Implementations ─────────────────────────────────────────────────

/**
 * macOS notification via osascript.
 */
export function notifyMacOS(opts: NotificationOptions): NotifyResult {
  const parts: string[] = []
  parts.push(`display notification "${escapeAppleString(opts.body)}"`)
  parts.push(`with title "${escapeAppleString(opts.title)}"`)
  if (opts.subtitle) {
    parts.push(`subtitle "${escapeAppleString(opts.subtitle)}"`)
  }
  if (opts.sound) {
    parts.push('sound name "Glass"')
  }

  try {
    execFileSync('osascript', ['-e', parts.join(' ')], {
      stdio: 'pipe',
      timeout: 5000,
    } as ExecFileSyncOptions)
    return { channel: 'macos', success: true }
  } catch (err) {
    return { channel: 'macos', success: false, error: (err as Error).message }
  }
}

function escapeAppleString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Linux notification via notify-send (libnotify).
 */
export function notifyLinux(opts: NotificationOptions): NotifyResult {
  const args: string[] = ['--app-name=ovolv999', opts.title, opts.body]
  if (opts.subtitle) {
    args.push('--hint=string:category:' + opts.subtitle)
  }

  try {
    execFileSync('notify-send', args, {
      stdio: 'pipe',
      timeout: 5000,
    } as ExecFileSyncOptions)
    return { channel: 'linux', success: true }
  } catch (err) {
    return { channel: 'linux', success: false, error: (err as Error).message }
  }
}

/**
 * Windows toast notification via PowerShell.
 */
export function notifyWindows(opts: NotificationOptions): NotifyResult {
  const script = `
    [System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null
    $balloon = New-Object System.Windows.Forms.NotifyIcon
    $balloon.Icon = [System.Drawing.SystemIcons]::Information
    $balloon.BalloonTipTitle = '${opts.title.replace(/'/g, "''")}'
    $balloon.BalloonTipText = '${opts.body.replace(/'/g, "''")}'
    $balloon.Visible = $true
    $balloon.ShowBalloonTip(5000)
  `.trim()

  try {
    execFileSync('powershell', ['-NoProfile', '-Command', script], {
      stdio: 'pipe',
      timeout: 10000,
    } as ExecFileSyncOptions)
    return { channel: 'windows', success: true }
  } catch (err) {
    return { channel: 'windows', success: false, error: (err as Error).message }
  }
}

/**
 * iTerm2 proprietary notification (OSC 9).
 */
export function notifyITerm2(opts: NotificationOptions): NotifyResult {
  // ESC ] 9 ; message ST
  const msg = `${opts.title}: ${opts.body}`
  process.stdout.write(`\x1b]9;${msg}\x07`)
  return { channel: 'iterm2', success: true }
}

/**
 * kitty terminal notification (OSC 99).
 */
export function notifyKitty(opts: NotificationOptions): NotifyResult {
  // ESC ] 99 ; title=...;body=... ST
  const payload = `title=${opts.title};body=${opts.body}`
  process.stdout.write(`\x1b]99;${payload}\x07`)
  return { channel: 'kitty', success: true }
}

/**
 * Simple terminal bell (works everywhere).
 */
export function notifyBell(_opts: NotificationOptions): NotifyResult {
  process.stdout.write('\x07')
  return { channel: 'bell', success: true }
}

// ── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Send a notification using the specified or auto-detected channel.
 * Falls back to bell if the primary channel fails.
 */
export function notify(options: NotificationOptions): NotifyResult {
  const channel = options.channel === 'auto' || !options.channel
    ? detectBestChannel()
    : options.channel

  let result: NotifyResult

  switch (channel) {
    case 'macos': result = notifyMacOS(options); break
    case 'linux': result = notifyLinux(options); break
    case 'windows': result = notifyWindows(options); break
    case 'iterm2': result = notifyITerm2(options); break
    case 'kitty': result = notifyKitty(options); break
    case 'bell': result = notifyBell(options); break
    default: result = notifyBell(options); break
  }

  // Fallback to bell if primary failed
  if (!result.success && channel !== 'bell') {
    notifyBell(options)
    return { channel: 'bell', success: true, error: `${result.channel} failed; fell back to bell` }
  }

  return result
}

/**
 * Async version (useful for fire-and-forget in UI).
 */
export function notifyAsync(options: NotificationOptions): Promise<NotifyResult> {
  return new Promise((resolve) => {
    try {
      resolve(notify(options))
    } catch (err) {
      resolve({ channel: options.channel ?? 'auto', success: false, error: (err as Error).message })
    }
  })
}

// ── Presets ─────────────────────────────────────────────────────────────────

export function notifyTaskComplete(taskName: string): NotifyResult {
  return notify({
    title: 'ovolv999 — Task Complete',
    body: taskName,
    sound: true,
    subtitle: 'Your task has finished',
  })
}

export function notifyError(errorMessage: string): NotifyResult {
  return notify({
    title: 'ovolv999 — Error',
    body: errorMessage.slice(0, 200),
    sound: true,
  })
}

export function notifyTestResults(passed: number, failed: number): NotifyResult {
  const status = failed === 0 ? 'All tests passed' : `${failed} test(s) failed`
  return notify({
    title: 'ovolv999 — Tests',
    body: `${status}: ${passed} passed, ${failed} failed`,
    sound: failed > 0,
  })
}
