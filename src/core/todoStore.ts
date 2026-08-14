/**
 * TodoStore — session-scoped task checklist state.
 *
 * Round 27 (live todos): the list previously lived in a module-level
 * array inside the TodoWrite tool — lost on exit, invisible to the
 * system prompt, and never restored on --resume. It now lives here
 * (core layer) so the runtime can inject the current list into every
 * LLM call, and persists to <sessionDir>/todo.json so a resumed
 * session picks up where it left off.
 *
 * CC parity: this injection is what makes todos STEER the model — the
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

let items: TodoItem[] = []
let loadedForDir: string | null = null

function todoPath(sessionDir: string): string {
  return join(sessionDir, TODO_FILENAME)
}

/** Hydrate from <sessionDir>/todo.json if we haven't already for this dir.
 *  Best-effort: corrupt/missing files just start an empty list. */
export function ensureLoaded(sessionDir: string | undefined): void {
  if (!sessionDir || sessionDir === loadedForDir) return
  loadedForDir = sessionDir
  try {
    const p = todoPath(sessionDir)
    if (existsSync(p)) {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as unknown
      if (Array.isArray(parsed)) {
        items = parsed.filter(
          (t): t is TodoItem =>
            typeof t === 'object' && t !== null &&
            typeof (t as TodoItem).id === 'string' &&
            typeof (t as TodoItem).content === 'string' &&
            typeof (t as TodoItem).status === 'string' &&
            typeof (t as TodoItem).priority === 'string',
        )
        return
      }
    }
  } catch { /* corrupt file → fresh list */ }
  items = []
}

function persist(sessionDir: string | undefined): void {
  if (!sessionDir) return
  try {
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(todoPath(sessionDir), JSON.stringify(items, null, 2) + '\n', 'utf8')
  } catch { /* best-effort persistence */ }
}

export function getTodos(): TodoItem[] {
  return items
}

/** Merge-by-id semantics identical to the previous in-tool logic:
 *  full replace when the incoming set covers every existing id,
 *  otherwise partial update. */
export function updateTodos(incoming: TodoItem[], sessionDir: string | undefined): TodoItem[] {
  const incomingIds = new Set(incoming.map((t) => t.id))
  const allExistingCovered = items.every((t) => incomingIds.has(t.id))
  if (items.length === 0 || allExistingCovered) {
    items = incoming.map((t) => ({ ...t }))
  } else {
    for (const updated of incoming) {
      const existing = items.find((t) => t.id === updated.id)
      if (existing) {
        existing.status = updated.status
        existing.priority = updated.priority
        existing.content = updated.content
        if (updated.activeForm !== undefined) existing.activeForm = updated.activeForm
      } else {
        items.push({ ...updated })
      }
    }
  }
  persist(sessionDir)
  return items
}

export function resetTodos(): void {
  items = []
  loadedForDir = null
}

export function renderTodoList(): string {
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
export function renderTodoPromptBlock(): string {
  if (items.length === 0) return ''
  const open = items.filter((t) => t.status !== 'completed').length
  const lines = [
    '# Current task checklist (live — keep working it, update via TodoWrite)',
    renderTodoList(),
    '',
    `${open} task(s) remaining. Mark items completed ONLY when fully done.`,
  ]
  return lines.join('\n')
}
