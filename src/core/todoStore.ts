/**
 * TodoStore — session-scoped task checklist state.
 *
 * Round 27 (live todos): the list previously lived in a module-level
 * array inside the TodoWrite tool — lost on exit, invisible to the
 * system prompt, and never restored on --resume. It lives here (core
 * layer) so the runtime can inject the current list into every LLM call,
 * and persists to <sessionDir>/todo.json so a resumed session picks up
 * where it left off.
 *
 * Round 30 (multi-session fix): store keyed per engine instead of one
 * module-global array.
 *
 * Round 31 (sub-agent ↔ sub-agent fix): the KEY is now a logical scope —
 * `todoScopeId ?? sessionDir ?? ''`. sessionDir ALONE was insufficient:
 * AgentTool children run with sessionDir=undefined, so every parallel
 * sub-agent shared the '' bucket and clobbered each other's checklists.
 * Each child engine now carries a unique todoScopeId; sessionDir is used
 * ONLY for disk persistence (main agent), never for isolation.
 *
 * CC parity: prompt injection is what makes todos STEER the model — the
 * plan survives context compaction because it is re-stated every turn.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

export interface TodoItem {
  id: string
  content: string
  activeForm?: string
  status: 'pending' | 'in_progress' | 'completed'
  priority: 'high' | 'medium' | 'low'
}

const TODO_FILENAME = 'todo.json'

interface SessionTodos {
  items: TodoItem[]
  /** True once hydrated from disk (or determined absent) for this dir. */
  loaded: boolean
}

const sessions = new Map<string, SessionTodos>()

function bucket(scopeKey: string): SessionTodos {
  let s = sessions.get(scopeKey)
  if (!s) {
    s = { items: [], loaded: false }
    sessions.set(scopeKey, s)
  }
  return s
}

function todoPath(sessionDir: string): string {
  return join(sessionDir, TODO_FILENAME)
}

/** Hydrate from <persistDir>/todo.json if we haven't already for this
 *  scope. Best-effort: corrupt/missing files just start an empty list. */
export function ensureLoaded(scopeKey: string, persistDir?: string): void {
  const s = bucket(scopeKey)
  if (s.loaded) return
  // Round 31 audit F2: only latch `loaded` when a persistDir was actually
  // consulted — a scope first touched without one (e.g. the coordinator's
  // pre-LLM call) must not poison a LATER disk-bearing call (the tool's)
  // into skipping hydration, which wiped the resumed plan on first write.
  if (!persistDir) return
  s.loaded = true
  try {
    const p = todoPath(persistDir)
    if (existsSync(p)) {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as unknown
      if (Array.isArray(parsed)) {
        s.items = parsed.filter(
          (t): t is TodoItem =>
            typeof t === 'object' && t !== null &&
            typeof (t as TodoItem).id === 'string' &&
            typeof (t as TodoItem).content === 'string' &&
            typeof (t as TodoItem).status === 'string' &&
            typeof (t as TodoItem).priority === 'string',
        )
      }
    }
  } catch { /* corrupt file → fresh list */ }
}

function persist(scopeKey: string, persistDir: string | undefined): void {
  if (!persistDir) return
  try {
    mkdirSync(persistDir, { recursive: true })
    writeFileSync(todoPath(persistDir), JSON.stringify(bucket(scopeKey).items, null, 2) + '\n', 'utf8')
  } catch { /* best-effort persistence */ }
}

export function getTodos(scopeKey: string): TodoItem[] {
  return bucket(scopeKey).items
}

/** Merge-by-id semantics identical to the previous in-tool logic:
 *  full replace when the incoming set covers every existing id,
 *  otherwise partial update. */
export function updateTodos(incoming: TodoItem[], scopeKey: string, persistDir?: string): TodoItem[] {
  const s = bucket(scopeKey)
  const incomingIds = new Set(incoming.map((t) => t.id))
  const allExistingCovered = s.items.every((t) => incomingIds.has(t.id))
  if (s.items.length === 0 || allExistingCovered) {
    s.items = incoming.map((t) => ({ ...t }))
  } else {
    for (const updated of incoming) {
      const existing = s.items.find((t) => t.id === updated.id)
      if (existing) {
        existing.status = updated.status
        existing.priority = updated.priority
        existing.content = updated.content
        if (updated.activeForm !== undefined) existing.activeForm = updated.activeForm
      } else {
        s.items.push({ ...updated })
      }
    }
  }
  persist(scopeKey, persistDir)
  return s.items
}

/** Test hook — drop every session bucket (and the disk-loaded flags). */
export function resetTodos(): void {
  sessions.clear()
}

export function renderTodoList(scopeKey: string): string {
  const items = bucket(scopeKey).items
  if (items.length === 0) return '(no tasks)'
  return items
    .map((item) => {
      const icon =
        item.status === 'completed' ? '✓' :
        item.status === 'in_progress' ? '◆' : '○'
      const pri = item.priority === 'high' ? '[H]' : item.priority === 'low' ? '[L]' : '  '
      const text = item.status === 'in_progress' && item.activeForm
        ? item.activeForm
        : item.content
      return `${icon} ${pri} ${text}`
    })
    .join('\n')
}

/** Block injected into the system prompt each LLM call. Empty (no-op)
 *  when no todos exist — zero prompt cost until the model plans. */
export function renderTodoPromptBlock(scopeKey: string): string {
  const items = bucket(scopeKey).items
  if (items.length === 0) return ''
  const open = items.filter((t) => t.status !== 'completed').length
  const lines = [
    '# Current task checklist (live — keep working it, update via TodoWrite)',
    renderTodoList(scopeKey),
    '',
    `${open} task(s) remaining. Mark items completed ONLY when fully done.`,
  ]
  return lines.join('\n')
}
