/**
 * GAP-D: tool ResourceClaim declarations (fi_goal §五).
 *
 * Verifies the 6 core file/shell tools (Read, Write, Edit, Bash, Grep,
 * Glob) declare per-input `claims` builders on their ToolMetadata.
 * These claims are what the ResourceScheduler (Round 7) consumes to
 * serialize conflicting operations. The scheduler integration itself
 * is deferred — this test confirms the DATA is observable.
 */

import { describe, it, expect } from 'vitest'
import { FileReadTool } from '../src/tools/fileRead.js'
import { FileWriteTool } from '../src/tools/fileWrite.js'
import { FileEditTool } from '../src/tools/fileEdit.js'
import { BashTool } from '../src/tools/bash.js'
import { GrepTool } from '../src/tools/grep.js'
import { GlobTool } from '../src/tools/glob.js'

describe('GAP-D: per-input ResourceClaim declarations', () => {
  describe('Read', () => {
    it('declares a read file claim when file_path is provided', () => {
      const t = new FileReadTool()
      const claims = t.metadata.claims({ file_path: '/a/b.ts' })
      expect(claims).toEqual([{ type: 'file', key: '/a/b.ts', access: 'read' }])
    })
    it('returns empty array when file_path is missing', () => {
      const t = new FileReadTool()
      expect(t.metadata.claims({})).toEqual([])
    })
  })

  describe('Write', () => {
    it('declares a write file claim', () => {
      const t = new FileWriteTool()
      const claims = t.metadata.claims({ file_path: '/x.txt', content: 'hi' })
      expect(claims).toEqual([{ type: 'file', key: '/x.txt', access: 'write' }])
    })
  })

  describe('Edit', () => {
    it('declares a write file claim', () => {
      const t = new FileEditTool()
      const claims = t.metadata.claims({
        file_path: '/y.txt',
        old_string: 'a',
        new_string: 'b',
      })
      expect(claims).toEqual([{ type: 'file', key: '/y.txt', access: 'write' }])
    })
  })

  describe('Grep', () => {
    it('declares a read directory claim when path is provided', () => {
      const t = new GrepTool()
      const claims = t.metadata.claims({ pattern: 'foo', path: '/repo' })
      expect(claims).toEqual([{ type: 'directory', key: '/repo', access: 'read' }])
    })
    it('returns empty array when path is omitted (whole-cwd search is too coarse)', () => {
      const t = new GrepTool()
      expect(t.metadata.claims({ pattern: 'foo' })).toEqual([])
    })
  })

  describe('Glob', () => {
    it('declares a read directory claim when path is provided', () => {
      const t = new GlobTool()
      const claims = t.metadata.claims({ pattern: '**/*.ts', path: '/repo' })
      expect(claims).toEqual([{ type: 'directory', key: '/repo', access: 'read' }])
    })
  })

  describe('Bash', () => {
    it('declares an exclusive git claim for git commands', () => {
      const t = new BashTool()
      const claims = t.metadata.claims({ command: 'git commit -m fix' })
      expect(claims).toEqual([{ type: 'git', key: 'HEAD', access: 'exclusive' }])
    })
    it('declares a process claim for non-git commands', () => {
      const t = new BashTool()
      const claims = t.metadata.claims({ command: 'npm install' })
      expect(claims.length).toBe(1)
      expect(claims[0].type).toBe('process')
      expect(claims[0].access).toBe('write')
      expect(claims[0].key).toBe('npm install')
    })
    it('strips binary path prefix when classifying (e.g. /usr/bin/git)', () => {
      const t = new BashTool()
      const claims = t.metadata.claims({ command: '/usr/bin/git status' })
      expect(claims[0].type).toBe('git')
    })
    it('returns empty array for empty command', () => {
      const t = new BashTool()
      expect(t.metadata.claims({ command: '' })).toEqual([])
      expect(t.metadata.claims({})).toEqual([])
    })
  })

  describe('claim consistency (conflict matrix sanity)', () => {
    it('Read claim on /a.ts conflicts with Write claim on /a.ts', () => {
      const read = new FileReadTool().metadata.claims({ file_path: '/a.ts' })
      const write = new FileWriteTool().metadata.claims({ file_path: '/a.ts' })
      // R/W on the same key MUST conflict (read while write = torn read).
      expect(read[0].key).toBe(write[0].key)
      expect(['read', 'write', 'exclusive']).toContain(read[0].access)
      expect(['read', 'write', 'exclusive']).toContain(write[0].access)
      // The conflict matrix in resourceScheduler is:
      //   read+write → conflict, read+exclusive → conflict,
      //   write+exclusive → conflict, write+write → conflict,
      //   read+read → no conflict.
      // So at least ONE of (read, write) must be write/exclusive.
      expect(read[0].access === 'write' || write[0].access === 'write').toBe(true)
    })
  })
})
