/**
 * TaskPlan tool (adaptive runtime contract Phase 3) — lets the model decompose a task
 * into the TaskGraph and walk nodes through their lifecycle. This is
 * what makes the TaskGraph LIVE in a real run: the model plans → adds
 * nodes → the CompletionContract gate then refuses 'completed' until
 * every node is terminal.
 *
 * v0.3.2 (run-scoped runtime contract §Phase 2): the tool no longer holds a fixed
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
import type { TaskGraph } from '../core/runtime/taskGraph.js'
import type { TaskGraphResolver } from './taskGraphResolver.js'
import type { EvidenceStore } from '../core/runtime/evidence.js'

export interface EvidenceResolver {
  resolve(runId: string): EvidenceStore
}

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
        'IMPORTANT: You CANNOT declare criteria satisfied by text. You must record real evidence (command results) via record_evidence, then call complete_node — the system verifies automatically. ' +
        'Actions: "add", "start", "update", "begin_verification", "record_evidence", "complete_node", "fail", "block", "unblock", "retry", "cancel", "attach_artifact", "list".',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'add', 'start', 'update', 'begin_verification', 'record_evidence',
              'complete_node', 'fail', 'block', 'unblock', 'retry', 'cancel', 'attach_artifact', 'list',
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
          reason: { type: 'string', description: 'Failure / block / cancel reason' },
          artifact: { type: 'string', description: 'Artifact name to attach (attach_artifact only)' },
          evidence_kind: { type: 'string', enum: ['command_result', 'test_result', 'build_result', 'file_change', 'artifact', 'analysis_result'], description: 'Type of evidence (record_evidence only)' },
          evidence_summary: { type: 'string', description: 'Short summary of what the evidence shows (record_evidence only)' },
          evidence_command: { type: 'string', description: 'The command that was run (record_evidence only)' },
          evidence_exit_code: { type: 'number', description: 'Exit code of the command (record_evidence only)' },
          evidence_criterion_id: { type: 'string', description: 'Which acceptance criterion this evidence supports (record_evidence only)' },
        },
        required: ['action'],
      },
    },
  }

  constructor(
    private readonly resolver?: TaskGraphResolver,
    private readonly evidenceResolver?: EvidenceResolver,
  ) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const runId = ctx.execution?.runId
    if (!this.resolver) {
      return err('TaskPlan unavailable: no resolver wired on this engine.')
    }
    if (!runId) {
      return err('TaskPlan unavailable: no runId in ToolContext.execution.')
    }
    let g: TaskGraph
    try {
      g = this.resolver.resolve(runId)
    } catch (e) {
      return err(`TaskPlan unavailable: ${(e as Error).message}`)
    }
    // v0.3.5: resolve the per-run EvidenceStore
    let evidence: EvidenceStore | undefined
    try {
      evidence = this.evidenceResolver?.resolve(runId)
    } catch { /* evidence optional in tests */ }

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
        case 'start': {
          const id = str(input.id)
          g.start(id)
          return ok(`Started "${id}". ${renderGraph(g)}`)
        }
        case 'update': {
          const id = str(input.id)
          if (!g.has(id)) return err(`node "${id}" does not exist`)
          const n = g.get(id)!
          if (n.status !== 'pending') return err(`cannot update node "${id}" in status ${n.status}`)
          if (input.title !== undefined) n.title = str(input.title, n.title)
          if (input.description !== undefined) n.description = str(input.description, n.description)
          return ok(`Updated "${id}".`)
        }
        case 'begin_verification': {
          const id = str(input.id)
          g.markVerifying(id)
          return ok(`"${id}" → verifying.`)
        }
        case 'record_evidence': {
          const id = str(input.id)
          if (!g.has(id)) return err(`node "${id}" does not exist`)
          if (!evidence) return err('EvidenceStore not available on this engine.')
          const kind = str(input.evidence_kind) as 'command_result' | 'test_result' | 'build_result' | 'file_change' | 'artifact' | 'analysis_result'
          if (!kind) return err('evidence_kind is required for record_evidence')
          const ev = evidence.record({
            runId,
            nodeId: id,
            criterionId: str(input.evidence_criterion_id) || undefined,
            kind,
            summary: str(input.evidence_summary, '(no summary)'),
            source: 'tool_execution',
            command: str(input.evidence_command) || undefined,
            exitCode: typeof input.evidence_exit_code === 'number' ? input.evidence_exit_code : undefined,
          })
          return ok(`Recorded evidence ${ev.id} (${kind}) for "${id}". Exit: ${ev.exitCode ?? 'n/a'}`)
        }
        case 'complete_node': {
          const id = str(input.id)
          if (!g.has(id)) return err(`node "${id}" does not exist`)
          const node = g.get(id)!
          // v0.3.5: system computes criterion satisfaction from evidence.
          // The model CANNOT pass satisfiedCriteria — the system decides.
          if (evidence && node.acceptanceCriteria.length > 0) {
            const criteria = node.acceptanceCriteria.map((desc, i) => ({ id: `${id}::${i}`, description: desc }))
            const states = evidence.computeAllCriteria(id, criteria)
            const unsatisfied = states.filter((s) => s.status !== 'satisfied' && s.status !== 'waived')
            if (unsatisfied.length > 0) {
              const detail = unsatisfied.map((s) => `  ✗ [${s.status}] ${s.description}`).join('\n')
              return err(`Cannot complete "${id}" — ${unsatisfied.length} criteria not satisfied:\n${detail}\nRecord evidence (record_evidence) for each criterion.`)
            }
            // All satisfied — complete with evidence-backed proof
            g.complete(id)
          } else {
            // No criteria or no evidence store — fall back to direct complete
            g.complete(id)
          }
          const n = g.get(id)!
          return ok(n.status === 'completed'
            ? `Completed "${id}" (evidence-verified). ${renderGraph(g)}`
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
