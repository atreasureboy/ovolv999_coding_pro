/**
 * Keybindings — user-configurable keyboard shortcuts.
 *
 * Loads bindings from `.ovolv999/keybindings.json`, validates them,
 * detects conflicts, and falls back to defaults for any unbound action.
 *
 * Config format (.ovolv999/keybindings.json):
 * {
 *   "bindings": {
 *     "ctrl+l": "clear-screen",
 *     "ctrl+o": "toggle-verbose",
 *     "ctrl+y": "copy-reply",
 *     "ctrl+r": "search-history",
 *     "ctrl+g": "open-editor",
 *     "ctrl+a": "cursor-home",
 *     "ctrl+e": "cursor-end",
 *     "ctrl+u": "clear-line",
 *     "ctrl+j": "newline",
 *     "?":       "toggle-help"
 *   }
 * }
 *
 * Inspired by Claude Code's keybinding system (src/config/keybindings.ts).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'

// ── Types ───────────────────────────────────────────────────────────────────

/** Named actions that can be bound to a key combo */
export type KeyAction =
  | 'clear-screen'
  | 'toggle-verbose'
  | 'copy-reply'
  | 'search-history'
  | 'open-editor'
  | 'cursor-home'
  | 'cursor-end'
  | 'clear-line'
  | 'newline'
  | 'toggle-help'
  | 'exit'
  | 'undo-edit'
  | 'toggle-plan-mode'

/** A parsed key combo */
export interface KeyCombo {
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  /** The character or special key name (e.g. 'l', '?', 'enter', 'tab') */
  key: string
}

/** User-facing config file format */
export interface KeybindingConfig {
  bindings: Partial<Record<KeyAction, string>>
}

export interface KeybindingLoadResult {
  /** The resolved bindings (defaults + user overrides) */
  bindings: Map<string, KeyAction>
  /** Conflicts detected in user config (same key → multiple actions) */
  conflicts: Array<{ key: string; actions: KeyAction[] }>
  /** Whether a user config file was found */
  hasUserConfig: boolean
  /** Validation errors (malformed entries) */
  errors: string[]
}

// ── Default Bindings ────────────────────────────────────────────────────────

export const DEFAULT_BINDINGS: Record<KeyAction, string> = {
  'clear-screen':    'ctrl+l',
  'toggle-verbose':  'ctrl+o',
  'copy-reply':      'ctrl+y',
  'search-history':  'ctrl+r',
  'open-editor':     'ctrl+g',
  'cursor-home':     'ctrl+a',
  'cursor-end':      'ctrl+e',
  'clear-line':      'ctrl+u',
  'newline':         'ctrl+j',
  'toggle-help':     '?',
  'exit':            'ctrl+c',
  'undo-edit':       'ctrl+z',
  'toggle-plan-mode':'ctrl+p',
}

export const ALL_KEY_ACTIONS: KeyAction[] = Object.keys(DEFAULT_BINDINGS) as KeyAction[]

// ── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Parse a key combo string like "ctrl+l", "alt+shift+x", "?" into normalized form.
 * Returns null if the string is malformed.
 */
export function parseKeyCombo(combo: string): KeyCombo | null {
  const trimmed = combo.trim().toLowerCase()
  if (!trimmed) return null

  const parts = trimmed.split('+')
  const result: KeyCombo = { key: '' }

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim()
    if (part === 'ctrl') result.ctrl = true
    else if (part === 'alt' || part === 'meta') result.alt = true
    else if (part === 'shift') result.shift = true
    else {
      // Last part is the key itself
      if (i !== parts.length - 1) return null // modifier in wrong position
      result.key = part
    }
  }

  if (!result.key) return null
  return result
}

/**
 * Normalize a KeyCombo into a comparable string key.
 * e.g. { ctrl: true, key: 'l' } → "ctrl+l"
 *      { key: '?' } → "?"
 */
export function comboToString(combo: KeyCombo): string {
  const mods: string[] = []
  if (combo.ctrl) mods.push('ctrl')
  if (combo.alt) mods.push('alt')
  if (combo.shift) mods.push('shift')
  return [...mods, combo.key].join('+')
}

/**
 * Match an Ink-style input/key pair against a combo string.
 * Ink provides: key.ctrl, key.meta (alt), key.shift, input (the char).
 */
export function matchCombo(
  input: string,
  key: { ctrl?: boolean; meta?: boolean; shift?: boolean },
  comboStr: string,
): boolean {
  const combo = parseKeyCombo(comboStr)
  if (!combo) return false

  // For ctrl combos, input is the control character (e.g. '\x0c' for ctrl+l)
  // Ink sets key.ctrl = true. We match on key.ctrl + the letter.
  if (combo.ctrl) {
    if (!key.ctrl) return false
    // Reject if actual press has modifiers the combo doesn't
    if (key.meta && !combo.alt) return false
    if (key.shift && !combo.shift) return false
    // Convert input control char back to letter for comparison
    const letter = ctrlCharToLetter(input)
    if (letter === null) return false
    return letter === combo.key
  }

  if (combo.alt && !key.meta) return false
  if (combo.shift && !key.shift) return false
  // Reject if actual press has modifiers the combo doesn't
  if (!combo.alt && key.meta) return false
  if (!combo.shift && key.shift) return false
  if (key.ctrl) return false

  // Plain key match (no modifiers)
  return input === combo.key
}

/** Convert a control character (e.g. '\x0c') to its letter ('l') */
function ctrlCharToLetter(input: string): string | null {
  if (input.length !== 1) return null
  const code = input.charCodeAt(0)
  // Ctrl+A = 1, Ctrl+B = 2, ..., Ctrl+Z = 26
  if (code >= 1 && code <= 26) {
    return String.fromCharCode(96 + code) // 1→'a', 2→'b', ..., 26→'z'
  }
  // Ctrl+[ = 27, Ctrl+\ = 28, Ctrl+] = 29, Ctrl+^ = 30, Ctrl+_ = 31
  const specials: Record<number, string> = {
    27: '[', 28: '\\', 29: ']', 30: '^', 31: '_',
  }
  return specials[code] ?? null
}

// ── Loader ──────────────────────────────────────────────────────────────────

const CONFIG_FILENAME = '.ovolv999/keybindings.json'

export function loadKeybindings(cwd: string): KeybindingLoadResult {
  const configPath = join(resolve(cwd), CONFIG_FILENAME)
  const errors: string[] = []
  const conflicts: Array<{ key: string; actions: KeyAction[] }> = []

  // Start with defaults
  const userBindings = new Map<string, KeyAction>()
  for (const [action, combo] of Object.entries(DEFAULT_BINDINGS)) {
    userBindings.set(combo, action as KeyAction)
  }

  let hasUserConfig = false

  if (existsSync(configPath)) {
    hasUserConfig = true
    try {
      const raw = readFileSync(configPath, 'utf8')
      const parsed = JSON.parse(raw) as unknown

      if (typeof parsed !== 'object' || parsed === null) {
        errors.push('Config root must be an object with a "bindings" field')
      } else {
        const cfg = parsed as Partial<KeybindingConfig>
        if (!cfg.bindings || typeof cfg.bindings !== 'object') {
          errors.push('Missing or invalid "bindings" object')
        } else {
          // Clear defaults and rebuild from user config + defaults
          userBindings.clear()

          // First pass: collect user bindings
          const userMap = new Map<KeyAction, string>()
          for (const [action, combo] of Object.entries(cfg.bindings)) {
            if (!ALL_KEY_ACTIONS.includes(action as KeyAction)) {
              errors.push(`Unknown action: "${action}". Valid: ${ALL_KEY_ACTIONS.join(', ')}`)
              continue
            }
            if (typeof combo !== 'string') {
              errors.push(`Invalid combo for "${action}": must be a string`)
              continue
            }
            const parsed = parseKeyCombo(combo)
            if (!parsed) {
              errors.push(`Malformed key combo: "${combo}" for action "${action}"`)
              continue
            }
            userMap.set(action as KeyAction, combo)
          }

          // Second pass: detect conflicts (same combo → multiple actions)
          const comboToActions = new Map<string, KeyAction[]>()
          for (const [action, combo] of userMap) {
            const existing = comboToActions.get(combo) ?? []
            existing.push(action)
            comboToActions.set(combo, existing)
          }
          for (const [combo, actions] of comboToActions) {
            if (actions.length > 1) {
              conflicts.push({ key: combo, actions })
            }
          }

          // Build final bindings map: user overrides + defaults for unbound
          // Skip conflicting combos entirely (fall back to default for those actions)
          for (const action of ALL_KEY_ACTIONS) {
            const userCombo = userMap.get(action)
            if (userCombo) {
              const isConflicting = comboToActions.get(userCombo)!.length > 1
              if (!isConflicting) {
                userBindings.set(userCombo, action)
                continue
              }
              // Conflicting — fall through to default
            }
            // Use default
            userBindings.set(DEFAULT_BINDINGS[action], action)
          }
        }
      }
    } catch (err) {
      errors.push(`Failed to parse config: ${(err as Error).message}`)
    }
  }

  return { bindings: userBindings, conflicts, hasUserConfig, errors }
}

// ── Lookup ──────────────────────────────────────────────────────────────────

/**
 * Find the action bound to a given key press.
 * Returns the action name or null if no binding exists.
 */
export function lookupAction(
  input: string,
  key: { ctrl?: boolean; meta?: boolean; shift?: boolean },
  bindings: Map<string, KeyAction>,
): KeyAction | null {
  for (const [combo, action] of bindings) {
    if (matchCombo(input, key, combo)) {
      return action
    }
  }
  return null
}

// ── Config Writer (for /keybindings command) ────────────────────────────────

export function writeDefaultConfig(cwd: string): string {
  const dir = join(resolve(cwd), '.ovolv999')
  mkdirSync(dir, { recursive: true })
  const configPath = join(dir, 'keybindings.json')

  const sample: KeybindingConfig = {
    bindings: { ...DEFAULT_BINDINGS },
  }

  writeFileSync(configPath, JSON.stringify(sample, null, 2) + '\n', 'utf8')
  return configPath
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Human-readable description of an action */
export const ACTION_DESCRIPTIONS: Record<KeyAction, string> = {
  'clear-screen':     'Clear the terminal screen',
  'toggle-verbose':   'Toggle verbose/compact output',
  'copy-reply':       'Copy last assistant reply to clipboard',
  'search-history':   'Reverse search through input history',
  'open-editor':      'Open prompt in external $EDITOR',
  'cursor-home':      'Move cursor to start of line',
  'cursor-end':       'Move cursor to end of line',
  'clear-line':       'Clear the current input line',
  'newline':          'Insert a newline (multi-line input)',
  'toggle-help':      'Toggle help overlay',
  'exit':             'Exit the application (double-press)',
  'undo-edit':        'Undo last file edit',
  'toggle-plan-mode': 'Toggle plan mode',
}
