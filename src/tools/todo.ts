/**
 * TodoWrite — task list management
 * Reference: src/tools/TodoWriteTool/
 *
 * Lets the LLM create and manage a checklist of subtasks.
 * Displayed in the terminal as ✓/○ items.
 * Stored in-process (per-session) — not persisted to disk.
 */

import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'

export interface TodoItem {
  id: string
  content: string
  activeForm?: string
  status: 'pending' | 'in_progress' | 'completed'
  priority: 'high' | 'medium' | 'low'
}

// Module-level store — shared across all tool invocations in a session
let todoList: TodoItem[] = []

function renderTodoList(): string {
  if (todoList.length === 0) return '(no tasks)'
  return todoList
    .map((item) => {
      const icon =
        item.status === 'completed' ? '✓' :
        item.status === 'in_progress' ? '◆' : '○'
      const pri = item.priority === 'high' ? '[H]' : item.priority === 'low' ? '[L]' : '   '
      // Show activeForm for in_progress tasks, content otherwise
      const text = item.status === 'in_progress' && item.activeForm
        ? item.activeForm
        : item.content
      return `${icon} ${pri} ${text}`
    })
    .join('\n')
}

export class TodoWriteTool implements Tool {
  name = 'TodoWrite'

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'TodoWrite',
      description: `Manage a task checklist for the current session.

## When to Use This Tool
Use this tool proactively in these scenarios:
1. Complex multi-step tasks (3+ distinct steps)
2. User provides multiple tasks (numbered or comma-separated)
3. After receiving new instructions — immediately capture as todos
4. When you start working on a task — mark it in_progress BEFORE beginning
5. After completing a task — mark it completed and add any follow-up tasks

## When NOT to Use
1. Single straightforward task
2. Trivial task (< 3 steps)
3. Purely conversational or informational

## Task States
- pending: Not yet started
- in_progress: Currently working on (**limit to ONE at a time**)
- completed: Fully finished

## Rules
- Exactly ONE task must be in_progress at any time (not zero, not two)
- Mark tasks complete IMMEDIATELY after finishing (don't batch)
- NEVER mark completed if: tests failing, implementation partial, errors unresolved
- Remove tasks that are no longer relevant
- Create specific, actionable items (not vague goals)
- Break complex tasks into smaller steps

## Fields
- id: unique identifier (e.g. "1", "2", "fix-auth")
- content: imperative form — what to do (e.g. "Fix authentication bug")
- activeForm: present continuous — shown during execution (e.g. "Fixing authentication bug")
- status: pending | in_progress | completed
- priority: high | medium | low

Operations:
- Provide full list to replace all todos
- Provide partial list with matching ids to update specific items`,
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: 'Full todo list (replaces existing) or partial updates (matched by id)',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Unique ID' },
                content: { type: 'string', description: 'Imperative: "Run tests"' },
                activeForm: { type: 'string', description: 'Present continuous: "Running tests"' },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed'],
                  description: 'Task status',
                },
                priority: {
                  type: 'string',
                  enum: ['high', 'medium', 'low'],
                  description: 'Task priority',
                },
              },
              required: ['id', 'content', 'status', 'priority'],
            },
          },
        },
        required: ['todos'],
      },
    },
  }

  execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const todos = input.todos as TodoItem[] | undefined

    if (!Array.isArray(todos)) {
      return Promise.resolve({ content: 'Error: todos must be an array', isError: true })
    }

    // Validate each item
    for (const item of todos) {
      if (!item.id || !item.content || !item.status || !item.priority) {
        return Promise.resolve({
          content: `Error: each todo must have id, content, status, and priority. Got: ${JSON.stringify(item)}`,
          isError: true,
        })
      }
    }

    // Update: merge by id. If id doesn't exist, add it.
    // If todos covers ALL existing ids, treat as replace.
    const incomingIds = new Set(todos.map(t => t.id))
    const allExistingCovered = todoList.every(t => incomingIds.has(t.id))

    if (todoList.length === 0 || allExistingCovered) {
      // Full replace
      todoList = todos.map(t => ({ ...t }))
    } else {
      // Partial update — merge by id
      for (const updated of todos) {
        const existing = todoList.find(t => t.id === updated.id)
        if (existing) {
          existing.status = updated.status
          existing.priority = updated.priority
          existing.content = updated.content
        } else {
          todoList.push({ ...updated })
        }
      }
    }

    const rendered = renderTodoList()
    return Promise.resolve({
      content: `Tasks updated:\n${rendered}`,
      isError: false,
    })
  }
}
