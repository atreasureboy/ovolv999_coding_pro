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
 * Round 30 (multi-session fix): the store is KEYED BY sessionDir. A
 * single process hosts multiple engines (main agent + AgentTool
 * sub-agents, tests) — the previous single module-global array meant the
 * sub-agent's ensureLoaded clobbered the parent's checklist and every
 * engine rendered the SAME list into its system prompt. Engines without
 * a sessionDir share the '' bucket (single-engine processes behave
 * exactly as before).
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

function bucket(sessionDir: string | undefined): SessionTodos {
  const key = sessionDir ?? ''
  let s = sessions.get(key)
  if (!s) {
    s = { items: [], loaded: false }
    sessions.set(key, s)
  }
  return s
}

function todoPath(sessionDir: string): string {
  return join(sessionDir, TODO_FILENAME)
}

/** Hydrate from <sessionDir>/todo.json if we haven't already for this dir.
 *  Best-effort: corrupt/missing files just start an empty list. */
export function ensureLoaded(sessionDir: string | undefined): void {
  const s = bucket(sessionDir)
  if (!sessionDir || s.loaded) return
  s.loaded = true
  try {
    const p = todoPath(sessionDir)
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

function persist(sessionDir: string | undefined): void {
  if (!sessionDir) return
  try {
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(todoPath(sessionDir), JSON.stringify(bucket(sessionDir).items, null, 2) + '\n', 'utf8')
  } catch { /* best-effort persistence */ }
}

export function getTodos(sessionDir?: string): TodoItem[] {
  return bucket(sessionDir).items
}

/** Merge-by-id semantics identical to the previous in-tool logic:
 *  full replace when the incoming set covers every existing id,
 *  otherwise partial update. */
export function updateTodos(incoming: TodoItem[], sessionDir: string | undefined): TodoItem[] {
  const s = bucket(sessionDir)
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
  persist(sessionDir)
  return s.items
}

/** Test hook — drop every session bucket (and the disk-loaded flags). */
export function resetTodos(): void {
  sessions.clear()
}

export function renderTodoList(sessionDir?: string): string {
  const items = bucket(sessionDir).items
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
export function renderTodoPromptBlock(sessionDir?: string): string {
  const items = bucket(sessionDir).items
  if (items.length === 0) return ''
  const open = items.filter((t) => t.status !== 'completed').length
  const lines = [
    '# Current task checklist (live — keep working it, update via TodoWrite)',
    renderTodoList(sessionDir),
    '',
    `${open} task(s) remaining. Mark items completed ONLY when fully done.`,
  ]
  return lines.join('\n')
}
