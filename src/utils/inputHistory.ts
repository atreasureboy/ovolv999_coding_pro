/**
 * Persistent input history — saves user prompts to ~/.ovolv999/history.jsonl
 * for cross-session recall via Up/Down arrow navigation.
 *
 * Format: one JSON object per line: { "text": "...", "ts": 1234567890 }
 * Max 100 entries (FIFO). Thread-safe via simple append + periodic compact.
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from 'fs'
import { atomicWriteSync } from '../core/atomicWrite.js'
import { join } from 'path'
import { homedir } from 'os'

const MAX_HISTORY = 100
const HISTORY_DIR = join(homedir(), '.ovolv999')
const HISTORY_FILE = join(HISTORY_DIR, 'history.jsonl')

export interface HistoryEntry {
  text: string
  ts: number
}

/**
 * Load persisted input history (most recent first).
 * Returns empty array if file doesn't exist or is corrupt.
 */
export function loadInputHistory(): string[] {
  try {
    if (!existsSync(HISTORY_FILE)) return []
    const raw = readFileSync(HISTORY_FILE, 'utf-8')
    const lines = raw.split('\n').filter((l) => l.trim())
    const entries: HistoryEntry[] = []
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as HistoryEntry
        if (typeof obj.text === 'string' && obj.text.trim()) {
          entries.push(obj)
        }
      } catch {
        // Skip corrupt lines
      }
    }
    // Most recent first, deduped
    const seen = new Set<string>()
    const result: string[] = []
    for (let i = entries.length - 1; i >= 0; i--) {
      const text = entries[i].text
      if (!seen.has(text)) {
        seen.add(text)
        result.push(text)
      }
    }
    return result.slice(0, MAX_HISTORY)
  } catch {
    return []
  }
}

/**
 * Append a new input to the persistent history file.
 * Creates the directory if it doesn't exist.
 * Silently fails on error (best-effort).
 */
export function saveInputHistory(text: string): void {
  const trimmed = text.trim()
  if (!trimmed) return

  try {
    if (!existsSync(HISTORY_DIR)) {
      mkdirSync(HISTORY_DIR, { recursive: true })
    }

    const entry: HistoryEntry = { text: trimmed, ts: Date.now() }
    appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n', 'utf-8')

    // Periodic compaction — when file grows large, rewrite with only last MAX entries
    compactIfNeeded()
  } catch {
    // Best-effort — silently ignore
  }
}

/**
 * If the history file has more than MAX_HISTORY * 2 lines, rewrite it
 * with only the most recent MAX_HISTORY entries.
 */
function compactIfNeeded(): void {
  try {
    if (!existsSync(HISTORY_FILE)) return
    const raw = readFileSync(HISTORY_FILE, 'utf-8')
    const lines = raw.split('\n').filter((l) => l.trim())
    if (lines.length <= MAX_HISTORY * 2) return

    // Keep last MAX_HISTORY lines
    const kept = lines.slice(-MAX_HISTORY)
    atomicWriteSync(HISTORY_FILE, kept.join('\n') + '\n')
  } catch {
    // Best-effort
  }
}

/**
 * Clear all persisted input history.
 */
export function clearInputHistory(): void {
  try {
    if (existsSync(HISTORY_FILE)) {
      writeFileSync(HISTORY_FILE, '', 'utf-8')
    }
  } catch {
    // Best-effort
  }
}

/** The history file path (exposed for testing). */
export function getHistoryFilePath(): string {
  return HISTORY_FILE
}
