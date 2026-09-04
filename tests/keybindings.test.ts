import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseKeyCombo,
  comboToString,
  matchCombo,
  loadKeybindings,
  lookupAction,
  writeDefaultConfig,
  DEFAULT_BINDINGS,
  ALL_KEY_ACTIONS,
  ACTION_DESCRIPTIONS,
  COMPOSER_ACTIONS,
  resolveComposerAction,
  type KeyAction,
} from '../src/ui/keybindings.js'

/**
 * Reproduces the transform ink/build/hooks/use-input.js applies before
 * invoking a useInput handler (ink's exports map blocks deep imports, so
 * the transform is mirrored here): parse-keypress maps ctrl bytes to
 * key.name with ctrl=true, and use-input then reports
 * `input = keypress.ctrl ? keypress.name : keypress.sequence` — so ctrl+l
 * arrives as input='l', while ctrl+j (the LF byte) arrives as input='\n'
 * with ctrl=false, named 'enter'.
 */
function inkEvent(data: string): { input: string; key: { ctrl: boolean; meta: boolean; shift: boolean } } {
  let keypress: { name?: string; sequence?: string; ctrl?: boolean; meta?: boolean; shift?: boolean }
  if (data.length === 1 && data >= '\x01' && data <= '\x1a' && data !== '\r' && data !== '\n' && data !== '\t' && data !== '\x1b') {
    keypress = { name: String.fromCharCode(96 + data.charCodeAt(0)), ctrl: true, sequence: data }
  } else if (data === '\r') {
    keypress = { name: 'return', ctrl: false, sequence: data }
  } else if (data === '\n') {
    keypress = { name: 'enter', ctrl: false, sequence: data }
  } else {
    keypress = { name: data, ctrl: false, sequence: data }
  }
  let input = keypress.ctrl ? (keypress.name ?? '') : (keypress.sequence ?? '')
  if (input.startsWith('\x1b')) input = input.slice(1)
  return {
    input,
    key: {
      ctrl: keypress.ctrl === true,
      meta: keypress.meta === true || keypress.name === 'escape',
      shift: keypress.shift === true,
    },
  }
}

describe('parseKeyCombo', () => {
  it('parses simple ctrl combo', () => {
    expect(parseKeyCombo('ctrl+l')).toEqual({ ctrl: true, key: 'l' })
  })

  it('parses plain key', () => {
    expect(parseKeyCombo('?')).toEqual({ key: '?' })
  })

  it('parses alt+shift combo', () => {
    expect(parseKeyCombo('alt+shift+x')).toEqual({ alt: true, shift: true, key: 'x' })
  })

  it('parses meta as alt', () => {
    expect(parseKeyCombo('meta+k')).toEqual({ meta: true, key: 'k' })
  })

  it('parses cmd as meta (macOS convention)', () => {
    expect(parseKeyCombo('cmd+k')).toEqual({ meta: true, key: 'k' })
  })

  it('parses super as meta (Linux convention)', () => {
    expect(parseKeyCombo('super+k')).toEqual({ meta: true, key: 'k' })
  })

  it('parses alt as alt (distinct from meta)', () => {
    expect(parseKeyCombo('alt+k')).toEqual({ alt: true, key: 'k' })
  })

  it('returns null for empty string', () => {
    expect(parseKeyCombo('')).toBeNull()
  })

  it('returns null for whitespace-only', () => {
    expect(parseKeyCombo('   ')).toBeNull()
  })

  it('returns null when no key after modifiers', () => {
    expect(parseKeyCombo('ctrl+')).toBeNull()
  })

  it('returns null when modifier is in wrong position', () => {
    expect(parseKeyCombo('l+ctrl')).toBeNull()
  })

  it('is case-insensitive', () => {
    expect(parseKeyCombo('CTRL+L')).toEqual({ ctrl: true, key: 'l' })
    expect(parseKeyCombo('Ctrl+Shift+X')).toEqual({ ctrl: true, shift: true, key: 'x' })
  })

  it('trims whitespace', () => {
    expect(parseKeyCombo('  ctrl + l  ')).toEqual({ ctrl: true, key: 'l' })
  })
})

describe('comboToString', () => {
  it('converts combo to string', () => {
    expect(comboToString({ ctrl: true, key: 'l' })).toBe('ctrl+l')
    expect(comboToString({ key: '?' })).toBe('?')
    expect(comboToString({ alt: true, shift: true, key: 'x' })).toBe('alt+shift+x')
  })

  it('round-trips: parseKeyCombo ∘ comboToString is identity', () => {
    const combos = ['ctrl+l', 'alt+x', 'meta+k', 'cmd+s', 'super+space', 'shift+tab', '?']
    for (const str of combos) {
      const parsed = parseKeyCombo(str)
      expect(parsed).not.toBeNull()
      const roundTripped = comboToString(parsed!)
      // meta/cmd/super all normalize to "meta+" prefix
      const expected = str.replace(/^(cmd|super)\+/, 'meta+')
      expect(roundTripped).toBe(expected)
    }
  })

  it('comboToString outputs meta for meta modifier (not alt)', () => {
    expect(comboToString({ meta: true, key: 'k' })).toBe('meta+k')
  })

  it('comboToString outputs alt for alt modifier', () => {
    expect(comboToString({ alt: true, key: 'k' })).toBe('alt+k')
  })
})

describe('matchCombo', () => {
  it('matches ctrl+l in the form Ink delivers (letter + ctrl flag)', () => {
    // Ink use-input.js: input = keypress.ctrl ? keypress.name : sequence
    expect(matchCombo('l', { ctrl: true }, 'ctrl+l')).toBe(true)
  })

  it('matches ctrl+l via raw control character (terminal-byte form)', () => {
    expect(matchCombo('\x0c', { ctrl: true }, 'ctrl+l')).toBe(true)
  })

  it('matches plain ? character', () => {
    expect(matchCombo('?', {}, '?')).toBe(true)
  })

  it('does not match when ctrl not pressed', () => {
    expect(matchCombo('l', {}, 'ctrl+l')).toBe(false)
  })

  it('does not match wrong ctrl letter (either form)', () => {
    expect(matchCombo('\x0c', { ctrl: true }, 'ctrl+k')).toBe(false)
    expect(matchCombo('k', { ctrl: true }, 'ctrl+l')).toBe(false)
  })

  it('matches ctrl+a through ctrl+z in both real forms', () => {
    for (let i = 0; i < 26; i++) {
      const letter = String.fromCharCode(97 + i)
      const ctrlChar = String.fromCharCode(1 + i)
      expect(matchCombo(letter, { ctrl: true }, `ctrl+${letter}`)).toBe(true)
      expect(matchCombo(ctrlChar, { ctrl: true }, `ctrl+${letter}`)).toBe(true)
    }
  })

  it('matches ctrl+j via the bare LF byte (no ctrl flag)', () => {
    // Terminals transmit ctrl+j as "\n"; parse-keypress names it 'enter'
    // and use-input passes it through with ctrl=false.
    expect(matchCombo('\n', {}, 'ctrl+j')).toBe(true)
  })

  it('does not match LF against a different ctrl combo', () => {
    expect(matchCombo('\n', {}, 'ctrl+k')).toBe(false)
  })

  it('does not match LF with extra modifiers', () => {
    expect(matchCombo('\n', { meta: true }, 'ctrl+j')).toBe(false)
    expect(matchCombo('\n', { shift: true }, 'ctrl+j')).toBe(false)
  })

  it('does not match when extra modifiers present', () => {
    expect(matchCombo('\x0c', { ctrl: true, meta: true }, 'ctrl+l')).toBe(false)
    expect(matchCombo('l', { ctrl: true, meta: true }, 'ctrl+l')).toBe(false)
  })

  it('returns false for malformed combo string', () => {
    expect(matchCombo('l', { ctrl: true }, '')).toBe(false)
  })

  it('distinguishes alt from meta in Ink key events', () => {
    // Ink's key.meta = Alt/Option (platform convention).
    // combo.alt maps to Ink's key.meta.
    // combo.meta (Super/Cmd) cannot be matched through Ink.
    expect(matchCombo('k', { meta: true }, 'alt+k')).toBe(true)
    expect(matchCombo('k', {}, 'alt+k')).toBe(false)
  })

  it('meta (Cmd/Super) combos are not matchable via Ink', () => {
    // Ink does not expose Super/Cmd key state, so meta-key combos
    // return false even when key.meta is pressed.
    expect(matchCombo('k', { meta: true }, 'meta+k')).toBe(false)
  })
})

describe('loadKeybindings', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kb-test-'))
  })

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('returns defaults when no config file', () => {
    const result = loadKeybindings(dir)
    expect(result.hasUserConfig).toBe(false)
    expect(result.errors).toHaveLength(0)
    expect(result.conflicts).toHaveLength(0)
    // Default for clear-screen is ctrl+l
    expect(result.bindings.get('ctrl+l')).toBe('clear-screen')
  })

  it('loads user overrides', () => {
    mkdirSync(join(dir, '.ovolv999'), { recursive: true })
    writeFileSync(
      join(dir, '.ovolv999', 'keybindings.json'),
      JSON.stringify({ bindings: { 'clear-screen': 'ctrl+k' } }),
    )
    const result = loadKeybindings(dir)
    expect(result.hasUserConfig).toBe(true)
    expect(result.errors).toHaveLength(0)
    // ctrl+k now maps to clear-screen
    expect(result.bindings.get('ctrl+k')).toBe('clear-screen')
    // ctrl+l is no longer bound (replaced)
    expect(result.bindings.get('ctrl+l')).toBeUndefined()
  })

  it('detects conflicts (same key → multiple actions)', () => {
    mkdirSync(join(dir, '.ovolv999'), { recursive: true })
    writeFileSync(
      join(dir, '.ovolv999', 'keybindings.json'),
      JSON.stringify({ bindings: {
        'clear-screen': 'ctrl+x',
        'toggle-verbose': 'ctrl+x', // conflict!
      }}),
    )
    const result = loadKeybindings(dir)
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0].key).toBe('ctrl+x')
    expect(result.conflicts[0].actions).toContain('clear-screen')
    expect(result.conflicts[0].actions).toContain('toggle-verbose')
  })

  it('reports error for unknown action', () => {
    mkdirSync(join(dir, '.ovolv999'), { recursive: true })
    writeFileSync(
      join(dir, '.ovolv999', 'keybindings.json'),
      JSON.stringify({ bindings: { 'unknown-action': 'ctrl+x' } }),
    )
    const result = loadKeybindings(dir)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0]).toContain('Unknown action')
  })

  it('reports error for malformed combo', () => {
    mkdirSync(join(dir, '.ovolv999'), { recursive: true })
    writeFileSync(
      join(dir, '.ovolv999', 'keybindings.json'),
      JSON.stringify({ bindings: { 'clear-screen': '' } }),
    )
    const result = loadKeybindings(dir)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('reports error for invalid JSON', () => {
    mkdirSync(join(dir, '.ovolv999'), { recursive: true })
    writeFileSync(join(dir, '.ovolv999', 'keybindings.json'), '{invalid json')
    const result = loadKeybindings(dir)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('reports error when bindings field is missing', () => {
    mkdirSync(join(dir, '.ovolv999'), { recursive: true })
    writeFileSync(join(dir, '.ovolv999', 'keybindings.json'), '{}')
    const result = loadKeybindings(dir)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0]).toContain('bindings')
  })

  it('falls back to defaults for conflicting actions', () => {
    mkdirSync(join(dir, '.ovolv999'), { recursive: true })
    writeFileSync(
      join(dir, '.ovolv999', 'keybindings.json'),
      JSON.stringify({ bindings: {
        'clear-screen': 'ctrl+x',
        'toggle-verbose': 'ctrl+x',
      }}),
    )
    const result = loadKeybindings(dir)
    // Conflicting combos are skipped, defaults are used instead
    expect(result.bindings.get('ctrl+l')).toBe('clear-screen')
    expect(result.bindings.get('ctrl+o')).toBe('toggle-verbose')
  })

  it('preserves non-conflicting user overrides alongside defaults', () => {
    mkdirSync(join(dir, '.ovolv999'), { recursive: true })
    writeFileSync(
      join(dir, '.ovolv999', 'keybindings.json'),
      JSON.stringify({ bindings: { 'clear-screen': 'ctrl+k' } }),
    )
    const result = loadKeybindings(dir)
    // User override
    expect(result.bindings.get('ctrl+k')).toBe('clear-screen')
    // Other defaults preserved
    expect(result.bindings.get('ctrl+o')).toBe('toggle-verbose')
    expect(result.bindings.get('?')).toBe('toggle-help')
  })
})

describe('lookupAction', () => {
  it('finds action for ctrl+l as Ink delivers it', () => {
    const bindings = new Map([['ctrl+l', 'clear-screen' as const]])
    expect(lookupAction('l', { ctrl: true }, bindings)).toBe('clear-screen')
  })

  it('returns null for unbound key', () => {
    const bindings = new Map([['ctrl+l', 'clear-screen' as const]])
    expect(lookupAction('x', {}, bindings)).toBeNull()
  })

  it('returns null for empty bindings', () => {
    expect(lookupAction('l', { ctrl: true }, new Map())).toBeNull()
  })
})

describe('writeDefaultConfig', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kb-write-'))
  })

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('creates config file with defaults', () => {
    const path = writeDefaultConfig(dir)
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.bindings).toEqual(DEFAULT_BINDINGS)
  })

  it('creates .ovolv999 directory if needed', () => {
    const path = writeDefaultConfig(dir)
    expect(path).toContain('.ovolv999')
  })
})

describe('DEFAULT_BINDINGS', () => {
  it('has bindings for all known actions', () => {
    for (const action of ALL_KEY_ACTIONS) {
      expect(DEFAULT_BINDINGS[action]).toBeDefined()
      expect(typeof DEFAULT_BINDINGS[action]).toBe('string')
    }
  })

  it('has unique default combos (no conflicts)', () => {
    const combos = Object.values(DEFAULT_BINDINGS)
    const unique = new Set(combos)
    expect(unique.size).toBe(combos.length)
  })
})

describe('ACTION_DESCRIPTIONS', () => {
  it('has descriptions for all actions', () => {
    for (const action of ALL_KEY_ACTIONS) {
      expect(ACTION_DESCRIPTIONS[action]).toBeDefined()
      expect(ACTION_DESCRIPTIONS[action].length).toBeGreaterThan(5)
    }
  })
})

describe('resolveComposerAction', () => {
  const defaultKeymap = new Map<string, KeyAction>(
    Object.entries(DEFAULT_BINDINGS).map(([action, combo]) => [combo, action as KeyAction]),
  )
  // The form Ink's useInput actually delivers for a ctrl combo: the plain
  // letter with the ctrl flag set.
  const inkCtrl = (letter: string): [string, { ctrl: boolean }] => [letter, { ctrl: true }]

  it('resolves the composer-owned defaults from Ink ctrl presses', () => {
    const cases: Array<[string, KeyAction]> = [
      ['r', 'search-history'],
      ['y', 'copy-reply'],
      ['g', 'open-editor'],
      ['a', 'cursor-home'],
      ['e', 'cursor-end'],
      ['u', 'clear-line'],
    ]
    for (const [letter, expected] of cases) {
      const [input, key] = inkCtrl(letter)
      expect(resolveComposerAction(input, key, defaultKeymap)).toBe(expected)
      expect(COMPOSER_ACTIONS.has(expected)).toBe(true)
    }
  })

  it('resolves newline from the bare LF byte (ctrl+j)', () => {
    expect(resolveComposerAction('\n', {}, defaultKeymap)).toBe('newline')
  })

  it('lets App-owned actions fall through (App dispatches them)', () => {
    expect(resolveComposerAction('l', { ctrl: true }, defaultKeymap)).toBeNull() // clear-screen
    expect(resolveComposerAction('o', { ctrl: true }, defaultKeymap)).toBeNull() // toggle-verbose
    expect(resolveComposerAction('c', { ctrl: true }, defaultKeymap)).toBeNull() // exit
    expect(resolveComposerAction('?', {}, defaultKeymap)).toBeNull() // toggle-help
    expect(resolveComposerAction('x', {}, defaultKeymap)).toBeNull() // unbound printable
  })

  it('honors a user rebinding of a composer action', () => {
    const rebound = new Map(defaultKeymap)
    rebound.delete('ctrl+g')
    rebound.set('ctrl+k', 'open-editor')
    // Old binding no longer fires; the new one does.
    expect(resolveComposerAction('g', { ctrl: true }, rebound)).toBeNull()
    expect(resolveComposerAction('k', { ctrl: true }, rebound)).toBe('open-editor')
  })
})

describe('Ink keypress round trip', () => {
  const defaultKeymap = new Map<string, KeyAction>(
    Object.entries(DEFAULT_BINDINGS).map(([action, combo]) => [combo, action as KeyAction]),
  )

  it('resolves App-owned actions from real terminal bytes', () => {
    const cases: Array<[string, KeyAction]> = [
      ['\x0c', 'clear-screen'],   // ctrl+l
      ['\x0f', 'toggle-verbose'], // ctrl+o
      ['\x03', 'exit'],           // ctrl+c (double-press logic lives in App)
      ['\x10', 'toggle-plan-mode'], // ctrl+p
      ['\x1a', 'undo-edit'],      // ctrl+z
      ['?', 'toggle-help'],       // printable binding, gated on empty composer
    ]
    for (const [byte, expected] of cases) {
      const { input, key } = inkEvent(byte)
      expect(lookupAction(input, key, defaultKeymap)).toBe(expected)
      expect(resolveComposerAction(input, key, defaultKeymap)).toBeNull()
    }
  })

  it('resolves composer-owned actions from real terminal bytes', () => {
    const cases: Array<[string, KeyAction]> = [
      ['\x12', 'search-history'], // ctrl+r
      ['\x19', 'copy-reply'],     // ctrl+y
      ['\x07', 'open-editor'],    // ctrl+g
      ['\x01', 'cursor-home'],    // ctrl+a
      ['\x05', 'cursor-end'],     // ctrl+e
      ['\x15', 'clear-line'],     // ctrl+u
      ['\n', 'newline'],          // ctrl+j — LF byte, arrives with no ctrl flag
    ]
    for (const [byte, expected] of cases) {
      const { input, key } = inkEvent(byte)
      expect(lookupAction(input, key, defaultKeymap)).toBe(expected)
      expect(resolveComposerAction(input, key, defaultKeymap)).toBe(expected)
    }
  })

  it('never resolves plain typing into an action', () => {
    for (const ch of 'hello world 42') {
      const { input, key } = inkEvent(ch)
      if (input === undefined || input === ' ') continue
      expect(lookupAction(input, key, defaultKeymap)).toBeNull()
    }
  })
})
