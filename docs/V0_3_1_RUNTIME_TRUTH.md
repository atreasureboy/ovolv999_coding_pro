# v0.3.1 Runtime Truth & Integration

> Status snapshot: 2026-07-24
> Source of truth: te_goal.md §十一 final-acceptance gate.

This document records the **real** runtime behaviour of the v0.3.1
Runtime Truth release. Every capability is annotated
**Fully wired / Partially wired / Experimental / Planned** and links
to the entry file, the key class, the call site that proves it, and
the test that guards it.

## Capability matrix

| # | Capability | Status | Entry file | Key class / fn | Real call site | Test |
|---|---|---|---|---|---|---|
| 1 | ModelRouter three-way split (setModelByUser / applyRoutingDecision / clearModelOverride) | **Fully wired** | `src/core/model/modelRouter.ts` | `ModelRouter.setModelByUser/applyRoutingDecision/clearModelOverride` | `src/core/engine.ts` `setSink` block | `tests/modelRouterApiSplit.test.ts` |
| 2 | ProviderRuntimeBinding + ModelRuntimeManager (cross-provider rejection) | **Fully wired** | `src/core/model/{providerRuntimeBinding,modelRuntimeManager}.ts` | `validateProfiles`, `BindingRegistry` | `engine.ts:115` `buildRouter` | `tests/modelRuntimeManager.test.ts` |
| 3 | RoutingSignalCollector (full 11-signal schema) | **Fully wired** | `src/core/model/routingSignalCollector.ts` | `collectRoutingSignals`, `signalsToRoutingInput` | `runtime/coordinator.ts:233` | `tests/routingSignalCollector.test.ts` |
| 4 | Provider fallback (real) | **Fully wired** | `src/core/model/modelGateway.ts` | `isRetryableProviderError`, `onProviderError` callback | `runtime/coordinator.ts:557` | `tests/providerFallback.test.ts` |
| 5 | CompletionContract 6-state schema | **Fully wired** | `src/core/runtime/completionContract.ts` | `evaluateCompletion` | `runtime/coordinator.ts:622` | `tests/completionContractStatus.test.ts` |
| 6 | TaskGraphStore per-runId isolation | **Fully wired** | `src/core/runtime/taskGraphStore.ts` | `InMemoryTaskGraphStore` | `runtime/coordinator.ts:281` | `tests/taskGraphStore.test.ts` |
| 7 | InternalControlMessage typed channel | **Fully wired** | `src/core/runtime/internalControlMessage.ts` | `ControlMessageLog` | `runtime/coordinator.ts:332` | `tests/internalControlMessage.test.ts` |
| 8 | ProgressMonitor sliding window (A→B→A→B + patch hash) | **Fully wired** | `src/core/runtime/progressMonitor.ts` | `recordToolCall`, `detectABABPattern` | `runtime/coordinator.ts:344` | `tests/progressMonitorSliding.test.ts` |
| 9 | Typed events (19 of 19 spec events) | **Fully wired** | `src/core/runtime/events.ts` | `RunEvent` union | engine + coordinator emit sites | `tests/runEventTypes.test.ts` |
| 10 | `/trace` / `/why` / `/progress` + duplicate detection | **Partially wired** | `src/commands/builtin.ts`, `src/commands/index.ts` | `registerCommand` strict dev mode | REPL `/trace`, `/why`, `/progress`, `/models`, `/route auto`, `/model auto` | `tests/slashCommandRealTrace.test.ts` |
| 11 | Deterministic eval matrix (≥15 cases) | **Fully wired** | `evals/{wiring-smoke,deterministic-runtime}` | n/a | `npm run eval:deterministic` | `evals/deterministic-runtime/deterministicRuntime.test.ts` |
| 12 | CLI `--model` → sticky manual override | **Fully wired** | `bin/ovogogogo.ts:1822` | `engine.setModelByUser` | CLI boot path | existing modelRouter tests + the call site above |
| 13 | Per-run health attribution via `recordCall` | **Fully wired** | `runtime/coordinator.ts:521-547` | `modelRouter.recordCall(profileId, ok, latencyMs, usage)` | coordinator callLLM wrapper | covered by `tests/providerFallback.test.ts` exercising the path |

## Real call chain (user input → final verdict)

```
user input → CLI/REPL (bin/ovogogogo.ts)
  → resolveApiEnvironment() picks provider (env > wizard > minimax/openai)
  → if --model present: engine.setModelByUser(config.model) [sticky override]
  → ExecutionEngine → RuntimeCoordinator.run()
    → boot() (modules, system prompt, ExecutionContext, toolContext)
    → [loop]
       → check_abort (TerminationPolicy)
       → budget_check (ContextManager)
       → collectRoutingSignals → routeModel → router.route → router.applyRoutingDecision
         (real fallback, real health attribution, real budget allocation)
       → module_iteration (single-track Critic + criticRequested gate)
       → llm_call
         → ModelGateway.call() [onProviderError wires Router.nextFallback]
         → StreamConsumer.consume()
         → recordUsage → costTracker.addUsage + modelRouter.recordCall
       → parse_response → tool_execution
         → ToolScheduler (claims-based partition) → ToolExecutor
       → budget_warning / stall_replan emitted via ControlMessageLog
         (rendered for THIS call, NOT accumulated in user history)
    → completion: stop_sequence → evaluateCompletion
      → 6-state verdict (completed | partial | blocked | failed | cancelled | exhausted)
      → RegistryRun transitions to succeeded | blocked | cancelled | failed
      → Reviewer verdict folded into CompletionInput
      → COMPLETION_EVALUATED / COMPLETION_REJECTED events emitted
```

## CompletionContract decision tree

```
evaluateCompletion(input):
  cancelled?       → cancelled
  failed?          → failed
  iterUsed >= max? → exhausted
  any blocker?     → blocked
  taskKind:
    informational:
      criteria empty or all met → completed
      else                       → partial
    analysis:
      criteria empty + changes  → completed
      else + changes            → partial
      else                      → incomplete
    mutation:
      criteria empty + changes  → completed
      else all met + verified   → completed
      else all met + unverified → completed (residual)
      else + changes            → partial
      else + no changes         → incomplete
```

## TaskGraph per-runId isolation

```
Coordinator.run(runId):
  store = engine.getTaskGraphStore()
  graph = store.get(runId) ?? store.create(runId)
  this.deps.taskGraph = graph       # per-run graph, NOT engine singleton
  graph.reset() (only when no runId)
  ... turn work ...
  graph.emit({ type: TASK_NODE_*, runId, nodeId, ... })   # every mutation
```

`/tasks <runId>` resolves the right graph; `store.close(runId)` drops it.

## InternalControlMessage separation

```
runtime nudges
  → ControlMessageLog.append({ kind, ... })
  → NOT pushed to messages[] (the user-visible history)
  → renderForProvider() produces a snapshot for THIS single LLM call
  → after the call: controlMessageLog.clear()      # never accumulated
  → across compaction: only budget_warning + completion_rejected are kept
```

`/export` and `sessionTranscript` filter out `isControlMessage(m)` so the
exported transcript never includes runtime nudges.

## Eval matrix

```bash
npm run eval:wiring          # 10 source-of-truth wiring checks
npm run eval:deterministic   # 15 runtime contract cases
npm run check                # typecheck + lint + unit + integration + deterministic
```

`eval:real` exists for opt-in real-LLM evaluation; default CI does NOT
run it (per te_goal §九.49).

## Current limitations (Planned)

- **Native Anthropic / Gemini adapters**: the runtime is single-transport
  OpenAI-compatible. Cross-provider profiles are rejected at config
  validation per te_goal §三.1.2 fallback. Native adapter is
  Experimental.
- **Stream timeout fallback**: `StreamConsumer` 120s timeout is NOT a
  fallback candidate (stream may have produced partial text). Surfaced
  as a hard error; the loop can retry on the next turn.
- **SQLite EventStore**: still NDJSON (`JsonlEventStore`). te_goal §八
  lists this as P2.
- **/trace <runId> --json**: the typed `RunEvent` union is in place but
  the slash command is currently a summary; JSON replay from EventStore
  is Partial — needs EventLog.query + JSON marshalling (P2).
- **CLI --provider switching at runtime**: not supported; restart with
  `--provider` flag is required.

## Migration notes

- `ModelRouter.setManualOverride(string|null)` is kept for back-compat
  with existing tests; production code goes through
  `setModelByUser / clearModelOverride`.
- `this.deps.taskGraph` in `CoordinatorDeps` is a back-compat shim; new
  code uses `taskGraphStore.create(runId)` /
  `taskGraphStore.get(runId)`.
- `CompletionInput.satisfiedCriteria: string[]` was replaced by the
  typed `acceptanceCriteria: AcceptanceCriterion[]` with per-criterion
  `satisfied: boolean`. The previous test fixture was updated; the
  function signature is breaking for any external caller.