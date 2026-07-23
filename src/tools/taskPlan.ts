/**
 * TaskPlan tool (eight_goal Phase 3) — lets the model decompose a task
 * into the TaskGraph and walk nodes through their lifecycle. This is
 * what makes the TaskGraph LIVE in a real run: the model plans → adds
 * nodes → the CompletionContract gate then refuses 'completed' until
 * every node is terminal.
 *
 * Actions: add | complete | fail | block | retry | list
 * The tool is a thin wrapper over the TaskGraph engine (src/core/runtime/
 * taskGraph.ts) — all invariants (dep resolution, acceptance gate,
 * cycle rejection, retry caps) live there.
 */

import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import { str } from '../core/strings.js'
import { TaskGraph } from '../core/runtime/taskGraph.js'

export class TaskPlanTool implements Tool {
  name = 'TaskPlan'
  metadata = { readOnly: false, concurrencySafe: false, mutatesState: true }
  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'TaskPlan',
      description:
        'Decompose a non-trivial task into a dependency-ordered plan and track each piece to completion. Use for medium/large tasks only — do NOT create a graph for trivial one-step work. ' +
        'The runtime refuses to mark the overall task completed while any node is unfinished or failed. ' +
        'Actions: "add" (create a node), "complete" (mark done — acceptance criteria must be satisfied), "fail", "block", "retry", "list".',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'complete', 'fail', 'block', 'retry', 'list'], description: 'Operation to perform' },
          id: { type: 'string', description: 'Node id (for add this is the new node id; for others, the target)' },
          title: { type: 'string', description: 'Short title (add only)' },
          description: { type: 'string', description: 'What this node accomplishes (add only)' },
          dependencies: { type: 'array', items: { type: 'string' }, description: 'Node ids that must complete before this one (add only)' },
          acceptanceCriteria: { type: 'array', items: { type: 'string' }, description: 'Criteria that must hold to complete this node (add only)' },
          resourceClaims: { type: 'array', items: { type: 'string' }, description: 'Resource keys this node touches (used to group parallel-safe nodes)' },
          preferredRole: { type: 'string', description: 'Hint role for sub-agent delegation (e.g. "worker")' },
          satisfiedCriteria: { type: 'array', items: { type: 'string' }, description: 'Criteria satisfied (complete only)' },
          reason: { type: 'string', description: 'Failure / block reason (fail/block only)' },
        },
        required: ['action'],
      },
    },
  }

  constructor(private readonly taskGraph?: TaskGraph) {}

  async execute(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const g = this.taskGraph
    if (!g) {
      return { content: 'TaskPlan unavailable: no task graph on this engine.', isError: true }
    }
    const action = str(input.action)
    try {
      switch (action) {
        case 'add': {
          const id = str(input.id)
          if (!id) return err('id is required for add')
          if (g.has(id)) return err(`node "${id}" already exists`)
          g.addNode({
            id,
            title: str(input.title, id),
            description: str(input.description),
            dependencies: asStrArr(input.dependencies),
            acceptanceCriteria: asStrArr(input.acceptanceCriteria),
            resourceClaims: asStrArr(input.resourceClaims),
            preferredRole: str(input.preferredRole) || undefined,
            retryPolicy: { maxAttempts: 2 },
          })
          return ok(`Added node "${id}". ${renderGraph(g)}`)
        }
        case 'complete': {
          const id = str(input.id)
          g.complete(id, asStrArr(input.satisfiedCriteria))
          const n = g.get(id)!
          return ok(n.status === 'completed'
            ? `Completed "${id}". ${renderGraph(g)}`
            : `Could not complete "${id}" → ${n.status}: ${n.failReason ?? ''}`)
        }
        case 'fail': {
          g.fail(str(input.id), str(input.reason, 'failed'))
          return ok(`Marked "${str(input.id)}" failed. ${renderGraph(g)}`)
        }
        case 'block': {
          g.block(str(input.id), str(input.reason, 'blocked'))
          return ok(`Marked "${str(input.id)}" blocked. ${renderGraph(g)}`)
        }
        case 'retry': {
          g.retry(str(input.id))
          const n = g.get(str(input.id))!
          return ok(`Node "${str(input.id)}" → ${n.status}.`)
        }
        case 'list':
          return ok(renderGraph(g))
        default:
          return err(`unknown action "${action}"`)
      }
    } catch (e) {
      return err((e as Error).message)
    }
  }
}

function renderGraph(g: TaskGraph): string {
  const s = g.snapshot().summary
  const head = `Plan: ${s.completed}/${s.total} done · ${s.failed} failed · ${s.blocked} blocked · ${s.running} running · ${s.ready} ready · ${s.pending} pending`
  const lines = g.snapshot().nodes.map((n) => {
    const deps = n.dependencies.length ? ` ←[${n.dependencies.join(',')}]` : ''
    const flag = n.status === 'blocked' ? ` ⚠${n.blockReason ? ' ' + n.blockReason : ''}`
      : n.status === 'failed' ? ` ✗${n.failReason ? ' ' + n.failReason : ''}` : ''
    return `  [${n.status}] ${n.title}${deps}${flag}`
  })
  return [head, ...lines].join('\n')
}

function asStrArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}
function ok(content: string): ToolResult {
  return { content, isError: false }
}
function err(content: string): ToolResult {
  return { content, isError: true }
}
