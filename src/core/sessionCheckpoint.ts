/**
 * SessionCheckpoint — save/restore workflow state (v0.6.0).
 *
 * Inspired by OpenCode's session checkpointing: capture the current
 * state of a coding session so it can be resumed later, even after a
 * crash or deliberate pause. Useful for long-running multi-turn
 * workflows where losing context is expensive.
 *
 * Checkpoint model:
 *   - checkpoint(name) → save current state to disk
 *   - restore(name) → load state back
 *   - list() → enumerate available checkpoints
 *   - rotate(max) → keep only the N most recent, delete older
 *   - auto-checkpoint → save on every N turns (configurable)
 *
 * Storage:
 *   - Checkpoints live under <project>/.ovolv999/checkpoints/
 *   - Each checkpoint is a JSON file: <name>.ckpt.json
 *   - Checkpoints are human-readable (pretty-printed JSON) for
 *     debugging and manual inspection
 *
 * Thread safety:
 *   - Write operations use atomic write (tmp file + rename)
 *   - Read operations are idempotent
 */

import { mkdirSync, readFileSync, readdirSync, unlinkSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { atomicWrite } from './atomicWrite.js'

// ── Types ───────────────────────────────────────────────────────────────────

export interface SessionCheckpoint {
  /** Unique checkpoint id */
  id: string
  /** User-provided name (or auto-generated) */
  name: string
  /** When the checkpoint was created */
  createdAt: string
  /** The conversation turn number at checkpoint time */
  turnNumber: number
  /** The model in use at checkpoint time */
  model?: string
  /** The task/goal being worked on */
  task?: string
  /** Summary of what was done so far */
  summary?: string
  /** Changed files between session start and checkpoint */
  changedFiles: string[]
  /** Git HEAD at checkpoint time */
  gitHead?: string
  /** Git branch at checkpoint time */
  gitBranch?: string
  /** Token usage accumulated up to this checkpoint */
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
  }
  /** Cost accumulated up to this checkpoint */
  costUSD?: number
  /** Arbitrary user metadata */
  tags?: string[]
  /** Opaque session state (the actual conversation) */
  state: unknown
}

export interface CheckpointListEntry {
  id: string
  name: string
  createdAt: string
  turnNumber: number
  task?: string
  summary?: string
  fileSize: number
}

export interface CheckpointStoreOptions {
  /** Project root directory */
  cwd: string
  /** Maximum checkpoints to keep (oldest auto-deleted). Default 20. */
  maxCheckpoints?: number
}

// ── Store ───────────────────────────────────────────────────────────────────

export class SessionCheckpointStore {
  readonly dir: string
  readonly maxCheckpoints: number

  constructor(opts: CheckpointStoreOptions) {
    this.dir = join(opts.cwd, '.ovolv999', 'checkpoints')
    this.maxCheckpoints = opts.maxCheckpoints ?? 20
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Save a checkpoint. Returns the checkpoint id.
   */
  async save(checkpoint: Omit<SessionCheckpoint, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): Promise<string> {
    mkdirSync(this.dir, { recursive: true })

    const id = checkpoint.id ?? `ckpt-${randomUUID().slice(0, 8)}`
    const full: SessionCheckpoint = {
      ...checkpoint,
      id,
      createdAt: checkpoint.createdAt ?? new Date().toISOString(),
    }

    const path = this.pathFor(id)
    await atomicWrite(path, JSON.stringify(full, null, 2))

    // Auto-rotate
    await this.rotate()

    return id
  }

  /**
   * Load a checkpoint by id or name.
   */
  load(idOrName: string): SessionCheckpoint | null {
    // Try exact id match first
    let path = this.pathFor(idOrName)
    if (!existsSync(path)) {
      // Try name match (search all checkpoints)
      const all = this.list()
      const match = all.find((e) => e.name === idOrName)
      if (!match) return null
      path = this.pathFor(match.id)
    }

    try {
      const raw = readFileSync(path, 'utf8')
      return JSON.parse(raw) as SessionCheckpoint
    } catch {
      return null
    }
  }

  /**
   * List all checkpoints, newest first.
   */
  list(): CheckpointListEntry[] {
    if (!existsSync(this.dir)) return []

    const entries: CheckpointListEntry[] = []
    let files: string[]
    try {
      files = readdirSync(this.dir)
    } catch {
      return []
    }

    for (const file of files) {
      if (!file.endsWith('.ckpt.json')) continue
      const path = join(this.dir, file)
      try {
        const raw = readFileSync(path, 'utf8')
        const ckpt = JSON.parse(raw) as SessionCheckpoint
        entries.push({
          id: ckpt.id,
          name: ckpt.name,
          createdAt: ckpt.createdAt,
          turnNumber: ckpt.turnNumber,
          task: ckpt.task,
          summary: ckpt.summary,
          fileSize: statSync(path).size,
        })
      } catch {
        // skip corrupted checkpoints
      }
    }

    // Sort newest first
    entries.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    return entries
  }

  /**
   * Delete a checkpoint by id.
   */
  delete(id: string): boolean {
    const path = this.pathFor(id)
    if (!existsSync(path)) return false
    try {
      unlinkSync(path)
      return true
    } catch {
      return false
    }
  }

  /**
   * Rotate: keep only the most recent `maxCheckpoints`, delete the rest.
   */
  async rotate(): Promise<number> {
    const all = this.list()
    if (all.length <= this.maxCheckpoints) return 0

    let deleted = 0
    // all is sorted newest-first, so delete from index maxCheckpoints onwards
    for (let i = this.maxCheckpoints; i < all.length; i++) {
      if (this.delete(all[i].id)) deleted++
    }
    return deleted
  }

  /**
   * Get the latest checkpoint (by creation time).
   */
  latest(): SessionCheckpoint | null {
    const all = this.list()
    if (all.length === 0) return null
    return this.load(all[0].id)
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private pathFor(id: string): string {
    return join(this.dir, `${id}.ckpt.json`)
  }
}

// ── Auto-checkpoint helper ──────────────────────────────────────────────────

export interface AutoCheckpointOptions {
  store: SessionCheckpointStore
  /** Auto-checkpoint every N turns. Default 5. Set to 0 to disable. */
  everyNTurns?: number
  /** Callback to collect current session state. */
  collectState: () => Omit<SessionCheckpoint, 'id' | 'createdAt'>
}

export class AutoCheckpoint {
  private store: SessionCheckpointStore
  private everyNTurns: number
  private collectState: () => Omit<SessionCheckpoint, 'id' | 'createdAt'>
  private turnCount = 0

  constructor(opts: AutoCheckpointOptions) {
    this.store = opts.store
    this.everyNTurns = opts.everyNTurns ?? 5
    this.collectState = opts.collectState
  }

  /**
   * Call this after every turn. Triggers a checkpoint every N turns.
   */
  async onTurn(): Promise<string | null> {
    this.turnCount++
    if (this.everyNTurns <= 0 || this.turnCount % this.everyNTurns !== 0) {
      return null
    }

    const state = this.collectState()
    return this.store.save({
      ...state,
      name: `auto-${this.turnCount}`,
      tags: [...(state.tags ?? []), 'auto'],
    })
  }

  /**
   * Force a checkpoint now (regardless of turn count).
   */
  async checkpoint(name?: string): Promise<string> {
    const state = this.collectState()
    return this.store.save({
      ...state,
      name: name ?? `manual-${this.turnCount}`,
      tags: [...(state.tags ?? []), 'manual'],
    })
  }
}