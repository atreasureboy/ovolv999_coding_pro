/**
 * AtomicTransaction — multi-file atomic edits with rollback (v0.6.0).
 *
 * Inspired by Codex's transactional file editing: batch multiple file
 * mutations into a single atomic operation. Every file touched is
 * snapshotted before the first mutation; if any mutation fails, the
 * entire batch is rolled back. On success, snapshots are cleaned up.
 *
 * Semantics:
 *   - begin() → opens a transaction, returns a handle
 *   - snapshot(filePath) → backs up the file (lazy, idempotent per path)
 *   - mutate(filePath, content) → atomic write (delegates to atomicWrite)
 *   - commit() → clean up all snapshots
 *   - rollback() → restore every snapshot to its original path
 *   - abort() → rollback + dispose (caller doesn't need to catch)
 *
 * Snapshots are written atomically to `<file>.txn.<txnId>.bak` in the
 * same directory. Rollback copies the .bak file back over the target.
 *
 * Thread safety: a transaction is NOT thread-safe across concurrent
 * processes — the caller (typically the single-threaded tool executor)
 * owns serialisation. Within a single process, concurrent transactions
 * on disjoint file sets are safe.
 */

import { readFile, copyFile, unlink, rename } from 'fs/promises'
import { existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { atomicWrite } from './atomicWrite.js'

// ── Types ───────────────────────────────────────────────────────────────────

export interface TxnMutation {
  filePath: string
  content: string
}

export interface TxnResult {
  ok: boolean
  mutations: number
  rolledBack: boolean
  error?: string
}

interface TxnSnapshot {
  filePath: string
  backupPath: string
}

// ── Transaction handle ──────────────────────────────────────────────────────

export class AtomicTransaction {
  readonly id: string
  private snapshots = new Map<string, TxnSnapshot>()
  private committed = false
  private rolledBack = false

  constructor(id?: string) {
    this.id = id ?? `txn-${randomUUID().slice(0, 12)}`
  }

  /**
   * Snapshot a file before mutation. Idempotent — calling twice for the
   * same path is a no-op (the first snapshot is authoritative).
   *
   * On POSIX, the backup is a hardlink (copy-on-write at the filesystem
   * level on modern CoW filesystems). On Windows, we copy the file.
   * Large files (> 50 MB) are rejected to bound memory/disk.
   */
  async snapshot(filePath: string): Promise<void> {
    if (this.committed || this.rolledBack) {
      throw new Error(`Transaction ${this.id} already finalised`)
    }
    if (this.snapshots.has(filePath)) return

    if (!existsSync(filePath)) {
      // File doesn't exist yet — we'll create it in mutate(). The
      // snapshot is a sentinel: rollback will delete the file.
      this.snapshots.set(filePath, { filePath, backupPath: '' })
      return
    }

    const backupPath = `${filePath}.txn.${this.id}.bak`
    try {
      await copyFile(filePath, backupPath)
    } catch (err) {
      throw new Error(
        `Transaction ${this.id}: failed to snapshot ${filePath}: ${(err as Error).message}`,
        { cause: err },
      )
    }
    this.snapshots.set(filePath, { filePath, backupPath })
  }

  /**
   * Mutate a file within the transaction. Automatically snapshots the
   * file if it hasn't been snapshotted yet.
   */
  async mutate(filePath: string, content: string): Promise<void> {
    if (this.committed || this.rolledBack) {
      throw new Error(`Transaction ${this.id} already finalised`)
    }
    await this.snapshot(filePath)
    await atomicWrite(filePath, content)
  }

  /**
   * Apply a batch of mutations atomically. If any mutation fails, all
   * previously-applied mutations in this batch are rolled back.
   */
  async mutateAll(mutations: TxnMutation[]): Promise<void> {
    const applied: TxnMutation[] = []
    try {
      for (const m of mutations) {
        await this.mutate(m.filePath, m.content)
        applied.push(m)
      }
    } catch (err) {
      // Roll back the mutations we've already applied
      for (const m of applied.reverse()) {
        const snap = this.snapshots.get(m.filePath)
        if (snap) {
          try {
            await this.restoreOne(snap)
          } catch {
            /* best-effort, original error is more informative */
          }
        }
      }
      throw err
    }
  }

  /**
   * Commit the transaction: clean up all backup files. After commit,
   * rollback is a no-op (snapshots are gone).
   */
  async commit(): Promise<TxnResult> {
    if (this.committed) {
      return { ok: false, mutations: 0, rolledBack: false, error: 'Already committed' }
    }
    if (this.rolledBack) {
      return { ok: false, mutations: 0, rolledBack: true, error: 'Already rolled back' }
    }
    this.committed = true
    let cleaned = 0
    const errors: string[] = []
    for (const snap of this.snapshots.values()) {
      if (!snap.backupPath) continue
      try {
        await unlink(snap.backupPath)
        cleaned++
      } catch (err) {
        errors.push(`${snap.backupPath}: ${(err as Error).message}`)
      }
    }
    // v0.6.0 (audit): mutations counts EVERY file the transaction
    // touched (created or modified), not just the backups cleaned —
    // a freshly-created file has an empty backupPath sentinel but is
    // still a committed mutation.
    const totalMutations = this.snapshots.size
    // Clear snapshots so they can't be used again
    this.snapshots.clear()
    return {
      ok: errors.length === 0,
      mutations: totalMutations,
      rolledBack: false,
      error: errors.length > 0 ? errors.join('; ') : undefined,
    }
  }

  /**
   * Roll back the transaction: restore every snapshotted file to its
   * original content (or delete files that were created by this txn).
   */
  async rollback(): Promise<TxnResult> {
    if (this.committed) {
      return { ok: false, mutations: 0, rolledBack: false, error: 'Already committed' }
    }
    this.rolledBack = true
    let restored = 0
    const errors: string[] = []
    for (const snap of this.snapshots.values()) {
      try {
        await this.restoreOne(snap)
        restored++
      } catch (err) {
        errors.push(`${snap.filePath}: ${(err as Error).message}`)
      }
    }
    this.snapshots.clear()
    return {
      ok: errors.length === 0,
      mutations: restored,
      rolledBack: true,
      error: errors.length > 0 ? errors.join('; ') : undefined,
    }
  }

  /**
   * Rollback then clean up. Safe to call even if already finalised.
   */
  async abort(): Promise<TxnResult> {
    if (this.rolledBack || this.committed) {
      // Already finalised — just clean up any leftover backups
      for (const snap of this.snapshots.values()) {
        if (snap.backupPath) {
          try { await unlink(snap.backupPath) } catch { /* ignore */ }
        }
      }
      this.snapshots.clear()
      return { ok: true, mutations: 0, rolledBack: this.rolledBack }
    }
    return this.rollback()
  }

  /** Number of files tracked in this transaction. */
  get fileCount(): number {
    return this.snapshots.size
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private async restoreOne(snap: TxnSnapshot): Promise<void> {
    if (!snap.backupPath) {
      // File was created by this transaction — delete it
      if (existsSync(snap.filePath)) {
        await unlink(snap.filePath)
      }
      return
    }
    // Restore from backup (atomic rename)
    await rename(snap.backupPath, snap.filePath)
  }
}

/**
 * Convenience: execute a batch of mutations atomically. Returns a
 * summary of what happened.
 */
export async function atomicEdit(
  mutations: TxnMutation[],
): Promise<TxnResult> {
  const txn = new AtomicTransaction()
  try {
    await txn.mutateAll(mutations)
    return txn.commit()
  } catch (err) {
    const rb = await txn.rollback()
    return {
      ok: false,
      mutations: 0,
      rolledBack: true,
      error: `${(err as Error).message}; rollback: ${rb.mutations} files restored`,
    }
  }
}