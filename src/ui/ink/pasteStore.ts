/**
 * Paste truncation — detects large paste input and replaces with a
 * compact placeholder reference, similar to Claude Code's behavior.
 *
 * When a paste exceeds the threshold, the text is stored in a paste store
 * and replaced with `[Pasted text #N +M lines]` in the input. The full
 * paste content is retrieved by reference when the prompt is submitted.
 */

const PASTE_THRESHOLD = 10_000

interface StoredPaste {
  id: number
  text: string
  lines: number
}

class PasteStore {
  private pastes = new Map<number, StoredPaste>()
  private nextId = 1

  /**
   * Round 47 (night audit): pastes previously lived in this map FOREVER —
   * every large paste (≥10KB) stayed resident even after submission, and
   * drafts that were never sent too. A long session pasting files would
   * grow memory without bound. Two bounds now:
   *   - LRU cap: oldest pastes evicted past MAX_STORED.
   *   - consume-on-expand: expand() deletes every placeholder it
   *     resolves (submission is the paste's single consumption point).
   * Consequence: re-submitting an OLD message that still contains a
   * placeholder sends the literal text — the paste was already delivered
   * once; re-expansion from history is not a supported flow.
   */
  private static readonly MAX_STORED = 20

  /** Store a paste and return the placeholder reference. */
  store(text: string): string {
    const id = this.nextId++
    const lines = text.split('\n').length
    this.pastes.set(id, { id, text, lines })
    while (this.pastes.size > PasteStore.MAX_STORED) {
      const oldest = this.pastes.keys().next().value
      if (oldest === undefined) break
      this.pastes.delete(oldest)
    }
    return `[Pasted text #${id} +${lines} lines]`
  }

  /** Retrieve the original paste content by ID. */
  get(id: number): string | undefined {
    return this.pastes.get(id)?.text
  }

  /**
   * Expand all `[Pasted text #N ...]` references in a string to their
   * original content. Called before sending the prompt to the engine.
   * Resolved pastes are consumed (deleted) — see the class doc.
   */
  expand(text: string): string {
    return text.replace(/\[Pasted text #(\d+) \+\d+ lines\]/g, (match: string, idStr: string) => {
      const id = parseInt(idStr, 10)
      const stored = this.pastes.get(id)
      if (stored === undefined) return match
      this.pastes.delete(id)
      return stored.text
    })
  }

  /** Check if input exceeds the paste threshold. */
  isLargePaste(input: string): boolean {
    return input.length > PASTE_THRESHOLD
  }

  /** Threshold value (exposed for testing). */
  get threshold(): number {
    return PASTE_THRESHOLD
  }
}

/** Singleton paste store instance. */
export const pasteStore = new PasteStore()
