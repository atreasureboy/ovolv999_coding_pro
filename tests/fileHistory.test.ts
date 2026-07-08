import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { FileHistory } from '../src/core/fileHistory.js'
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const TEST_DIR = join(tmpdir(), `ovolv999_fh_test_${Date.now()}`)

describe('FileHistory', () => {
  let history: FileHistory
  const testFile = join(TEST_DIR, 'src', 'test.ts')

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true })
    mkdirSync(join(TEST_DIR, 'src'), { recursive: true })
    writeFileSync(testFile, 'original content', 'utf8')
    history = new FileHistory(TEST_DIR)
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  describe('trackEdit', () => {
    it('backs up file before modification', () => {
      history.trackEdit(testFile)
      writeFileSync(testFile, 'modified content', 'utf8')

      const files = history.getEditedFiles()
      expect(files).toHaveLength(1)
      expect(files[0].path).toBe(testFile)
      expect(files[0].versions).toBe(1)
    })

    it('skips non-existent files (new files)', () => {
      const newPath = join(TEST_DIR, 'new.ts')
      history.trackEdit(newPath) // file doesn't exist yet

      const files = history.getEditedFiles()
      expect(files).toHaveLength(0)
    })

    it('tracks multiple versions of the same file', () => {
      history.trackEdit(testFile)
      writeFileSync(testFile, 'v1', 'utf8')

      history.trackEdit(testFile)
      writeFileSync(testFile, 'v2', 'utf8')

      const versions = history.getVersions(testFile)
      expect(versions).toHaveLength(2)
      expect(readFileSync(versions[0].backupPath, 'utf8')).toBe('original content')
      expect(readFileSync(versions[1].backupPath, 'utf8')).toBe('v1')
    })
  })

  describe('getEditedFiles', () => {
    it('returns empty list when no edits tracked', () => {
      expect(history.getEditedFiles()).toHaveLength(0)
    })

    it('tracks multiple files', () => {
      const file2 = join(TEST_DIR, 'other.ts')
      writeFileSync(file2, 'other', 'utf8')

      history.trackEdit(testFile)
      history.trackEdit(file2)

      const files = history.getEditedFiles()
      expect(files).toHaveLength(2)
    })

    it('reports current size and last modified', () => {
      history.trackEdit(testFile)
      writeFileSync(testFile, 'new longer content here', 'utf8')

      const files = history.getEditedFiles()
      expect(files[0].currentSize).toBeGreaterThan(files[0].originalSize!)
      expect(files[0].lastModified).not.toBeNull()
    })
  })

  describe('restoreOriginal', () => {
    it('restores file to its original content', () => {
      history.trackEdit(testFile)
      writeFileSync(testFile, 'completely changed', 'utf8')

      const restored = history.restoreOriginal(testFile)
      expect(restored).toBe(true)
      expect(readFileSync(testFile, 'utf8')).toBe('original content')
    })

    it('returns false for untracked file', () => {
      expect(history.restoreOriginal(join(TEST_DIR, 'untracked.ts'))).toBe(false)
    })
  })

  describe('restoreVersion', () => {
    it('restores to a specific version', () => {
      history.trackEdit(testFile)
      writeFileSync(testFile, 'v1', 'utf8')

      history.trackEdit(testFile)
      writeFileSync(testFile, 'v2', 'utf8')

      // Restore to version 1 (the 'v1' backup)
      expect(history.restoreVersion(testFile, 1)).toBe(true)
      expect(readFileSync(testFile, 'utf8')).toBe('v1')

      // Restore to version 0 (the original)
      expect(history.restoreVersion(testFile, 0)).toBe(true)
      expect(readFileSync(testFile, 'utf8')).toBe('original content')
    })

    it('returns false for invalid version number', () => {
      history.trackEdit(testFile)
      expect(history.restoreVersion(testFile, 99)).toBe(false)
      expect(history.restoreVersion(testFile, -1)).toBe(false)
    })
  })

  describe('getVersions', () => {
    it('returns version metadata with timestamps', () => {
      history.trackEdit(testFile)

      const versions = history.getVersions(testFile)
      expect(versions).toHaveLength(1)
      expect(versions[0].version).toBe(0)
      expect(versions[0].timestamp).toBeGreaterThan(0)
      expect(versions[0].size).toBe('original content'.length)
      expect(existsSync(versions[0].backupPath)).toBe(true)
    })

    it('returns empty for untracked file', () => {
      expect(history.getVersions(join(TEST_DIR, 'nope.ts'))).toHaveLength(0)
    })
  })

  describe('getSummary', () => {
    it('reports no edits when empty', () => {
      expect(history.getSummary()).toContain('No file edits')
    })

    it('reports file count and versions', () => {
      history.trackEdit(testFile)
      writeFileSync(testFile, 'v1', 'utf8')
      history.trackEdit(testFile)

      const summary = history.getSummary()
      expect(summary).toContain('1 file(s) edited')
      expect(summary).toContain('2 version(s)')
      expect(summary).toContain('test.ts')
    })
  })

  describe('clear', () => {
    it('clears all tracked edits', () => {
      history.trackEdit(testFile)
      history.clear()
      expect(history.getEditedFiles()).toHaveLength(0)
    })
  })
})
