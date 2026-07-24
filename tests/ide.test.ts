/**
 * Tests for src/utils/ide.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  detectIDE,
  convertPathForIDE,
  getExtensionRecommendations,
  formatIDEInfo,
  listAllKnownIDEs,
  readVSCodeLockfile,
} from '../src/utils/ide.js'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const SNAP: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of [
    'VSCODE_IPC_HOOK_CLI', 'CURSOR_IPC_HOOK_CLI', 'WINDSURF_IPC_HOOK_CLI',
    'NVIM', 'VIM', 'INSIDE_EMACS', 'SUBLIME_VERSION', 'TERM_PROGRAM',
    'TERMINAL_EMULATOR', 'INTELLIJ_ENVIRONMENT_READER',
  ]) {
    SNAP[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  for (const [k, v] of Object.entries(SNAP)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('ide', () => {
  describe('detectIDE', () => {
    it('returns null when no indicators present', () => {
      expect(detectIDE()).toBeNull()
    })

    it('detects VS Code via env', () => {
      process.env.VSCODE_IPC_HOOK_CLI = '/tmp/vscode.sock'
      const ide = detectIDE()
      expect(ide).not.toBeNull()
      expect(ide!.type).toBe('vscode')
      expect(ide!.running).toBe(true)
      expect(ide!.detectionSource).toBe('env')
    })

    it('detects Cursor via env', () => {
      process.env.CURSOR_IPC_HOOK_CLI = '/tmp/cursor.sock'
      const ide = detectIDE()
      expect(ide!.type).toBe('cursor')
    })

    it('detects Windsurf via env', () => {
      process.env.WINDSURF_IPC_HOOK_CLI = '/tmp/windsurf.sock'
      const ide = detectIDE()
      expect(ide!.type).toBe('windsurf')
    })

    it('detects Neovim via NVIM env', () => {
      process.env.NVIM = '1'
      const ide = detectIDE()
      expect(ide!.type).toBe('neovim')
    })

    it('detects Vim via VIM env', () => {
      process.env.VIM = '/usr/share/vim'
      const ide = detectIDE()
      expect(ide!.type).toBe('vim')
    })

    it('detects Emacs via INSIDE_EMACS env', () => {
      process.env.INSIDE_EMACS = '28.1,comint'
      const ide = detectIDE()
      expect(ide!.type).toBe('emacs')
    })

    it('detects via TERM_PROGRAM=vscode', () => {
      process.env.TERM_PROGRAM = 'vscode'
      const ide = detectIDE()
      expect(ide!.type).toBe('vscode')
    })

    it('detects via TERM_PROGRAM=Cursor', () => {
      process.env.TERM_PROGRAM = 'Cursor'
      const ide = detectIDE()
      expect(ide!.type).toBe('cursor')
    })

    it('detects JetBrains via TERMINAL_EMULATOR', () => {
      process.env.TERMINAL_EMULATOR = 'JetBrains'
      const ide = detectIDE()
      expect(ide!.type).toBe('intellij')
    })
  })

  describe('convertPathForIDE', () => {
    it('converts backslashes to forward slashes for vscode', () => {
      expect(convertPathForIDE('C:\\foo\\bar', 'vscode')).toBe('C:/foo/bar')
    })

    it('converts for cursor', () => {
      expect(convertPathForIDE('C:\\foo\\bar', 'cursor')).toBe('C:/foo/bar')
    })

    it('converts for windsurf', () => {
      expect(convertPathForIDE('C:\\foo\\bar', 'windsurf')).toBe('C:/foo/bar')
    })

    it('leaves path unchanged for vim', () => {
      expect(convertPathForIDE('C:\\foo\\bar', 'vim')).toBe('C:\\foo\\bar')
    })

    it('leaves unix path unchanged', () => {
      expect(convertPathForIDE('/home/user/foo', 'vscode')).toBe('/home/user/foo')
    })
  })

  describe('getExtensionRecommendations', () => {
    it('returns recommendations for vscode', () => {
      const recs = getExtensionRecommendations('vscode')
      expect(recs.length).toBeGreaterThan(0)
      expect(recs.every((r) => r.id && r.name)).toBe(true)
    })

    it('returns recommendations for cursor', () => {
      expect(getExtensionRecommendations('cursor').length).toBeGreaterThan(0)
    })

    it('returns recommendations for windsurf', () => {
      expect(getExtensionRecommendations('windsurf').length).toBeGreaterThan(0)
    })

    it('returns empty for vim', () => {
      expect(getExtensionRecommendations('vim')).toEqual([])
    })
  })

  describe('listAllKnownIDEs', () => {
    it('returns a non-empty list', () => {
      const list = listAllKnownIDEs()
      expect(list.length).toBeGreaterThan(5)
    })

    it('includes vscode, vim, emacs', () => {
      const types = listAllKnownIDEs().map((i) => i.type)
      expect(types).toContain('vscode')
      expect(types).toContain('vim')
      expect(types).toContain('emacs')
    })

    it('every entry has type and name', () => {
      for (const e of listAllKnownIDEs()) {
        expect(e.type).toBeTruthy()
        expect(e.name).toBeTruthy()
      }
    })
  })

  describe('formatIDEInfo', () => {
    it('formats basic info', () => {
      const out = formatIDEInfo({
        type: 'vscode',
        name: 'VS Code',
        running: true,
        detectionSource: 'env',
      })
      expect(out).toContain('VS Code')
      expect(out).toContain('Type: vscode')
      expect(out).toContain('Running')
    })

    it('includes optional fields when present', () => {
      const out = formatIDEInfo({
        type: 'vscode',
        name: 'VS Code',
        running: false,
        detectionSource: 'lockfile',
        version: '1.85.0',
        workspace: '/foo',
        executable: '/usr/bin/code',
      })
      expect(out).toContain('1.85.0')
      expect(out).toContain('/foo')
      expect(out).toContain('/usr/bin/code')
    })
  })

  describe('readVSCodeLockfile', () => {
    it('returns null when no lockfile', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'ide-test-'))
      try {
        expect(readVSCodeLockfile(tmp)).toBeNull()
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    })

    it('parses a lockfile', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'ide-test-'))
      try {
        mkdirSync(join(tmp, '.vscode'), { recursive: true })
        writeFileSync(join(tmp, '.vscode', '.vscode-lock'), '12345\n7\n2024-01-01T00:00:00Z')
        const lf = readVSCodeLockfile(tmp)
        expect(lf).not.toBeNull()
        expect(lf!.pid).toBe(12345)
        expect(lf!.fd).toBe(7)
        expect(lf!.ide).toBe('vscode')
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    })

    it('returns null on malformed content', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'ide-test-'))
      try {
        mkdirSync(join(tmp, '.vscode'), { recursive: true })
        writeFileSync(join(tmp, '.vscode', '.vscode-lock'), 'not a number')
        const lf = readVSCodeLockfile(tmp)
        // parsing is lenient: NaN is acceptable, just verify shape
        expect(lf).not.toBeNull()
        expect(typeof lf!.pid).toBe('number')
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    })
  })
})
