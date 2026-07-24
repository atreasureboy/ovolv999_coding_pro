/**
 * TaskPlan tool (eight_goal Phase 3) — lets the model decompose a task
 * into the TaskGraph and walk nodes through their lifecycle. This is
 * what makes the TaskGraph LIVE in a real run: the model plans → adds
 * nodes → the CompletionContract gate then refuses 'completed' until
 * every node is terminal.
 *
 * v0.3.2 (ele_goal §Phase 2): the tool no longer holds a fixed
 * TaskGraph. It receives a TaskGraphResolver and resolves the graph
 * for the current runId from ToolContext.execution.runId. Removing
 * the constructor-injected graph is the single source-identity fix
 * for TaskGraph pollution.
 *
 * Actions: add | start | update | begin_verification | complete |
 *          fail | block | unblock | retry | cancel | attach_artifact | list
 * The tool is a thin wrapper over the TaskGraph engine (src/core/runtime/
 * taskGraph.ts) — all invariants (dep resolution, acceptance gate,
 * cycle rejection, retry caps) live there.
 */

import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import { str } from '../core/strings.js'
import { TaskGraph } from '../core/runtime/taskGraph.js'
import type { TaskGraphResolver } from './taskGraphResolver.js'

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
        'Actions: "add" (create a node), "start" (pending→running), "update" (edit fields), "begin_verification", "complete" (acceptance gate), "fail", "block", "unblock", "retry", "cancel", "attach_artifact", "list".',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'add', 'start', 'update', 'begin_verification', 'complete',
              'fail', 'block', 'unblock', 'retry', 'cancel', 'attach_artifact', 'list',
            ],
            description: 'Operation to perform',
          },
          id: { type: 'string', description: 'Node id (for add this is the new node id; for others, the target)' },
          title: { type: 'string', description: 'Short title (add/update only)' },
          description: { type: 'string', description: 'What this node accomplishes (add/update only)' },
          dependencies: { type: 'array', items: { type: 'string' }, description: 'Node ids that must complete before this one (add only)' },
          acceptanceCriteria: { type: 'array', items: { type: 'string' }, description: 'Criteria that must hold to complete this node (add only)' },
          resourceClaims: { type: 'array', items: { type: 'string' }, description: 'Resource keys this node touches' },
          preferredRole: { type: 'string', description: 'Hint role for sub-agent delegation' },
          preferredModelProfile: { type: 'string', description: 'Hint model profile id for sub-agent delegation' },
          satisfiedCriteria: { type: 'array', items: { type: 'string' }, description: 'Criteria satisfied (complete only)' },
          reason: { type: 'string', description: 'Failure / block / cancel reason' },
          artifact: { type: 'string', description: 'Artifact name to attach to the node (attach_artifact only)' },
        },
        required: ['action'],
      },
    },
  }

  constructor(private readonly resolver?: TaskGraphResolver) {}

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    // v0.3.2 (ele_goal §Phase 2): resolve the graph for the CURRENT
    // run from the resolver. Production never falls back to a
    // shared 'default' graph.
    const runId = ctx.execution?.runId
    if (!this.resolver) {
      return err('TaskPlan unavailable: no resolver wired on this engine.')
    }
    if (!runId) {
      return err('TaskPlan unavailable: no runId in ToolContext.execution. The Engine must mint a runId before invoking tools.')
    }
    let g: TaskGraph
    try {
      g = this.resolver.resolve(runId)
    } catch (e) {
      return err(`TaskPlan unavailable: ${(e as Error).message}`)
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
            preferredModelProfile: str(input.preferredModelProfile) || undefined,
            retryPolicy: { maxAttempts: 2 },
          })
          return ok(`Added node "${id}". ${renderGraph(g)}`)
        }
        case 'start': {
          const id = str(input.id)
          g.start(id)
          return ok(`Started "${id}". ${renderGraph(g)}`)
        }
        case 'update': {
          const id = str(input.id)
          if (!g.has(id)) return err(`node "${id}" does not exist`)
          // Update allowed only on pending nodes; mutation after start
          // risks invalidating the dep graph mid-run.
          const n = g.get(id)!
          if (n.status !== 'pending') return err(`cannot update node "${id}" in status ${n.status}`)
          if (input.title !== undefined) n.title = str(input.title, n.title)
          if (input.description !== undefined) n.description = str(input.description, n.description)
          if (input.preferredRole !== undefined) n.preferredRole = str(input.preferredRole) || undefined
          if (input.preferredModelProfile !== undefined) n.preferredModelProfile = str(input.preferredModelProfile) || undefined
          return ok(`Updated "${id}".`)
        }
        case 'begin_verification': {
          const id = str(input.id)
          g.markVerifying(id)
          return ok(`"${id}" → verifying.`)
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
        case 'unblock': {
          g.unblock(str(input.id))
          return ok(`Unblocked "${str(input.id)}". ${renderGraph(g)}`)
        }
        case 'cancel': {
          // v0.3.1 (te_goal §五): use the engine's cancel() so the
          // node is terminal-cancelled (unblock cannot reverse it).
          const id = str(input.id)
          g.cancel(id, str(input.reason, 'cancelled'))
          return ok(`Cancelled "${id}". ${renderGraph(g)}`)
        }
        case 'attach_artifact': {
          const id = str(input.id)
          const art = str(input.artifact)
          if (!art) return err('artifact is required for attach_artifact')
          g.attachArtifact(id, art)
          return ok(`Attached "${art}" to "${id}".`)
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
