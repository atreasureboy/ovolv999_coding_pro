import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { FileHistory, MAX_VERSIONS_PER_FILE } from '../src/core/fileHistory.js'
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

  // ── sidecar: per-backup originalPath + rebuild from sidecar ─────────────
  //
  // The on-disk hash directory is a BUCKET, never a path. The
  // load-bearing record that ties a backup back to its ORIGINAL file is
  // the per-backup sidecar `<backup>.meta.json`. These tests pin both
  // halves: the sidecar is WRITTEN on trackEdit, and when the primary
  // index is gone the rebuild path recovers the original path FROM the
  // sidecar alone.

  describe('per-backup sidecar (originalPath)', () => {
    it('writes a sidecar JSON next to each backup with the original absolute path', () => {
      history.trackEdit(testFile)
      const versions = history.getVersions(testFile)
      expect(versions).toHaveLength(1)
      const sidecarPath = `${versions[0].backupPath}.meta.json`
      expect(existsSync(sidecarPath)).toBe(true)
      const parsed = JSON.parse(readFileSync(sidecarPath, 'utf8'))
      expect(parsed.originalPath).toBe(testFile)
    })

    it('unlinks the sidecar when its backup is evicted (cap)', () => {
      const dir = join(TEST_DIR, 'src', 'cap.ts')
      writeFileSync(dir, 'v0', 'utf8')
      history.trackEdit(dir)
      const firstBackup = history.getVersions(dir)[0].backupPath
      const firstSidecar = `${firstBackup}.meta.json`
      expect(existsSync(firstSidecar)).toBe(true)

      // Push past the cap so the oldest is evicted.
      for (let i = 1; i <= MAX_VERSIONS_PER_FILE + 5; i++) {
        history.trackEdit(dir)
        writeFileSync(dir, `v${i}`, 'utf8')
      }
      // Both the backup AND its sidecar must be gone.
      expect(existsSync(firstBackup)).toBe(false)
      expect(existsSync(firstSidecar)).toBe(false)
    })

    it('rebuildIndex recovers the original path from per-backup sidecars when the index is gone', () => {
      // Simulate a session pre-dating / losing the persistent index:
      // write 2 backups with their sidecars directly, then construct a
      // fresh FileHistory. The rebuild path must use the sidecar to
      // recover the original path.
      const fp1 = join(TEST_DIR, 'src', 'one.ts')
      const fp2 = join(TEST_DIR, 'src', 'two.ts')
      writeFileSync(fp1, 'one-original', 'utf8')
      writeFileSync(fp2, 'two-original', 'utf8')
      history.trackEdit(fp1)
      history.trackEdit(fp2)

      // Nuke the persistent index so the constructor falls through to
      // the rebuild path. The per-backup sidecars are untouched.
      const indexPath = join(TEST_DIR, 'file-history', 'index.json')
      rmSync(indexPath, { force: true })

      const fresh = new FileHistory(TEST_DIR)
      const files = fresh.getEditedFiles().map((f) => f.path).sort()
      // The hash directory name MUST NOT appear here — the rebuild
      // path reads the sidecar to recover the ORIGINAL absolute path.
      expect(files).toEqual([fp1, fp2].sort())
      // And restoreVersion still works through the rebuilt index.
      expect(fresh.restoreVersion(fp1, 0)).toBe(true)
      expect(readFileSync(fp1, 'utf8')).toBe('one-original')
    })

    it('drops backups with missing or corrupt sidecars rather than treating the hash as a path', () => {
      // The hash directory name is 32 hex chars — it looks like a path
      // but is NOT a file path. A rebuild must NEVER key a backup on
      // the hash name; it must drop the backup if its sidecar is gone.
      const fp = join(TEST_DIR, 'src', 'orphan.ts')
      writeFileSync(fp, 'content', 'utf8')
      history.trackEdit(fp)
      const versions = history.getVersions(fp)
      const backupPath = versions[0].backupPath
      const sidecarPath = `${backupPath}.meta.json`

      // Delete BOTH the persistent index AND the sidecar. Rebuild sees
      // an orphan backup with no trustworthy metadata.
      rmSync(join(TEST_DIR, 'file-history', 'index.json'), { force: true })
      rmSync(sidecarPath, { force: true })

      const fresh = new FileHistory(TEST_DIR)
      const files = fresh.getEditedFiles()
      // The backup is dropped — getEditedFiles must NOT return the
      // hash directory as a path. This is the "hash is a bucket, not
      // a path" invariant.
      const hash = backupPath.split('/').slice(-2, -1)[0]
      expect(files.map((f) => f.path)).not.toContain(hash)
      expect(files.map((f) => f.path)).not.toContain(fp)
    })

    it('a sidecar with the wrong shape (no originalPath) is also dropped', () => {
      const fp = join(TEST_DIR, 'src', 'bad-sidecar.ts')
      writeFileSync(fp, 'content', 'utf8')
      history.trackEdit(fp)
      const versions = history.getVersions(fp)
      const backupPath = versions[0].backupPath
      const sidecarPath = `${backupPath}.meta.json`

      // Overwrite the sidecar with garbage (no originalPath field).
      writeFileSync(sidecarPath, JSON.stringify({ unrelated: true }), 'utf8')
      rmSync(join(TEST_DIR, 'file-history', 'index.json'), { force: true })

      const fresh = new FileHistory(TEST_DIR)
      const files = fresh.getEditedFiles()
      expect(files.map((f) => f.path)).not.toContain(fp)
    })
  })
})
