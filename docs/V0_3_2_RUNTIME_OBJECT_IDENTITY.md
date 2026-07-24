# V0.3.2 Runtime Object Identity & Semantic Truth

> Triggered by `ele_goal.md`. Status: implemented + tested.
> 199 test files / 4103 tests pass · tsc 0 · lint 0.

## Architecture: RunScopedRuntimeContext

Every component in a Run now resolves the **same** `RunScopedRuntimeContext`
for the same `runId`. The Context is created at run start, holds the
TaskGraph / ProgressMonitor / ControlMessageLog / routingSignals /
completionVerdict, and is closed at run end.

```
coordinator.run()
  → store.create(runId, { taskKind })           [RunScopedRuntimeContext]
  → classifyTaskIntent(userMessage)              [TaskIntent: informational/analysis/mutation]
  → collectRoutingSignals(ctx)                   [real signals from WorkingState + ProgressMonitor]
  → router.route(signals)                        [model selection]
  → boot → loop(tools → verify → stall → critic)
  → stop_sequence → CompletionCandidate
  → Reviewer.reviewRun(state)                    [deterministic verdict]
  → evaluateCompletion(taskKind, verification, taskGraph, children)
  → CompletionVerdict                            [completed/partial/blocked/incomplete]
  → RunRegistry transition from verdict
  → RUN_COMPLETED (AFTER verdict, not before)
  → store.close(runId)
```

## Object identity guarantees

| Component | How it gets the current Run's objects |
|---|---|
| TaskPlanTool | `TaskGraphResolver.resolve(ctx.execution.runId)` → scoped graph |
| CompletionContract | reads scoped TaskGraph + WorkingState from the coordinator |
| ProgressMonitor | per-Run instance inside RunScopedRuntimeContext |
| ModelRouter | routeModel callback receives enriched RoutingInput from coordinator |
| CriticModule | risk signal from coordinator via `criticRequested` in iteration context |
| Reviewer | coordinator calls reviewRun with WorkingState snapshot |

Turn N's TaskGraph is created fresh; turn N+1 does NOT inherit turn N's nodes.

## TaskIntent (pre-execution classification)

`classifyTaskIntent(userMessage)` determines `taskKind` BEFORE any tools run:
- **mutation**: fix/implement/refactor/add/remove/edit/modify → requires changes + verification
- **analysis**: audit/analyze/review/design/investigate → requires evidence output, no patch
- **informational**: what/why/how/explain/summarize/list → no changes required

taskKind is NOT derived from "did files change?" — a mutation that fails to
change anything is still classified as mutation → blocked by CompletionContract.

## CompletionVerdict as sole truth

`evaluateCompletion()` is the SINGLE entry point. Its verdict drives:
- RunRegistry status (completed→succeeded, blocked/incomplete→blocked, etc.)
- Renderer output (shows verdict + reasons)
- TaskPlanTool node completion (acceptance criteria check)

taskKind drives what "done" means: informational tasks can complete without
file changes; mutation tasks cannot.

## CriterionEvidence

Each acceptance criterion has a typed evidence record (test/command/file-
change/review/manual). `TaskPlan complete` must provide criterionId +
evidenceType — string-match alone is not accepted.

## Fallback attribution

ModelGateway records per-attempt outcomes:
- `MODEL_ATTEMPT_STARTED/FAILED/SUCCEEDED` events per try
- `ROUTING_FALLBACK` event on model switch
- Cost/usage attributed to the model that actually produced the stream
- The failed model gets a failure record; the fallback model gets a success

## Event lifecycle

```
RUN_STARTED → CONTEXT_CREATED → TASK_GRAPH_CREATED →
MODEL_REQUESTED → MODEL_COMPLETED → TOOL_* →
REVIEW_COMPLETED → COMPLETION_EVALUATED →
RUN_COMPLETED (only AFTER verdict)
```

Terminal events fire exactly once. Blocked runs emit the appropriate
non-completed terminal (not a semantic RUN_COMPLETED).

## Remaining limitations

- Provider fallback is same-transport (switches model string within one
  adapter); cross-provider client switching is not yet implemented (cross-
  provider profiles are accepted at config level but share one client).
- `/trace` reads from current object state + event subscriptions; full
  EventStore replay (reading persisted JSONL) is the next step.
- RoutingSignalCollector passes real signals but some fields use proxies
  (repoFileCount ≈ filesTouched × 10); a real repo indexer is future work.
