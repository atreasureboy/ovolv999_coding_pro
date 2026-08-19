import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { FileHistory } from '../src/core/fileHistory.js'
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, unlinkSync, chmodSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const TEST_DIR = join(tmpdir(), `ovolv999_fh_redo_${Date.now()}_${Math.floor(Math.random() * 1e6)}`)
const file = join(TEST_DIR, 'target.ts')

describe('FileHistory undo/redo', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true })
    writeFileSync(file, 'C0', 'utf8')
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it('undo restores the previous version and redo returns to the undone state', () => {
    const fh = new FileHistory(TEST_DIR)

    fh.trackEdit(file)
    writeFileSync(file, 'C1', 'utf8')
    fh.trackEdit(file)
    writeFileSync(file, 'C2', 'utf8')

    expect(fh.undoEdit(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('C1')
    expect(fh.getRedoDepth(file)).toBe(1)

    expect(fh.redoEdit(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('C2')
    expect(fh.getRedoDepth(file)).toBe(0)
  })

  it('walks the full timeline in both directions', () => {
    const fh = new FileHistory(TEST_DIR)
    fh.trackEdit(file)
    writeFileSync(file, 'C1', 'utf8')
    fh.trackEdit(file)
    writeFileSync(file, 'C2', 'utf8')
    fh.trackEdit(file)
    writeFileSync(file, 'C3', 'utf8')

    expect(fh.undoEdit(file)).toBe(true) // -> C2
    expect(fh.undoEdit(file)).toBe(true) // -> C1
    expect(fh.undoEdit(file)).toBe(true) // -> C0
    expect(readFileSync(file, 'utf8')).toBe('C0')
    expect(fh.undoEdit(file)).toBe(false) // nothing left

    expect(fh.redoEdit(file)).toBe(true) // -> C1
    expect(readFileSync(file, 'utf8')).toBe('C1')
    expect(fh.redoEdit(file)).toBe(true) // -> C2
    expect(fh.redoEdit(file)).toBe(true) // -> C3
    expect(readFileSync(file, 'utf8')).toBe('C3')
    expect(fh.redoEdit(file)).toBe(false)
  })

  it('a new edit invalidates the redo stack', () => {
    const fh = new FileHistory(TEST_DIR)
    fh.trackEdit(file)
    writeFileSync(file, 'C1', 'utf8')
    fh.trackEdit(file)
    writeFileSync(file, 'C2', 'utf8')

    expect(fh.undoEdit(file)).toBe(true) // -> C1, redo=[C2]
    expect(fh.getRedoDepth(file)).toBe(1)

    fh.trackEdit(file) // new edit branch
    writeFileSync(file, 'C1b', 'utf8')
    expect(fh.getRedoDepth(file)).toBe(0)
    expect(fh.redoEdit(file)).toBe(false)
  })

  it('round-trips file deletion through undo/redo', () => {
    const fh = new FileHistory(TEST_DIR)

    // Simulated tool flow: backup before change, then delete.
    fh.trackEdit(file)
    unlinkSync(file)
    expect(fh.undoEdit(file)).toBe(true) // restore C0
    expect(readFileSync(file, 'utf8')).toBe('C0')

    // Delete again and redo back to the restored state.
    fh.trackEdit(file)
    unlinkSync(file)
    expect(fh.undoEdit(file)).toBe(true) // -> C0 again
    expect(fh.redoEdit(file)).toBe(true) // -> deleted state
    expect(existsSync(file)).toBe(false)
    expect(fh.undoEdit(file)).toBe(true) // -> C0 restored
    expect(readFileSync(file, 'utf8')).toBe('C0')
  })

  it('persisted redo stack survives a fresh FileHistory instance', () => {
    const fh = new FileHistory(TEST_DIR)
    fh.trackEdit(file)
    writeFileSync(file, 'C1', 'utf8')
    expect(fh.undoEdit(file)).toBe(true) // redo=[C1]

    const fh2 = new FileHistory(TEST_DIR)
    expect(fh2.getRedoDepth(file)).toBe(1)
    expect(fh2.redoEdit(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('C1')
  })

  it('restoreVersion clears the redo stack', () => {
    const fh = new FileHistory(TEST_DIR)
    fh.trackEdit(file)
    writeFileSync(file, 'C1', 'utf8')
    fh.trackEdit(file)
    writeFileSync(file, 'C2', 'utf8')
    expect(fh.undoEdit(file)).toBe(true) // -> C1, redo=[C2]
    expect(fh.getRedoDepth(file)).toBe(1)

    expect(fh.restoreVersion(file, 0)).toBe(true)
    expect(fh.getRedoDepth(file)).toBe(0)
  })

  it('preserves file mode across undo/redo', () => {
    chmodSync(file, 0o755)
    const fh = new FileHistory(TEST_DIR)
    fh.trackEdit(file) // backs up content + mode 0755
    writeFileSync(file, 'C1', 'utf8')
    chmodSync(file, 0o600)

    fh.undoEdit(file)
    expect(statSync(file).mode & 0o777).toBe(0o755)
    fh.redoEdit(file)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('undo returns false for untracked files', () => {
    const fh = new FileHistory(TEST_DIR)
    expect(fh.undoEdit(join(TEST_DIR, 'never.ts'))).toBe(false)
    expect(fh.redoEdit(join(TEST_DIR, 'never.ts'))).toBe(false)
  })
})
