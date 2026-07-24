# V0.3.1 Adaptive Runtime — Architecture Audit & Status (updated)

> Triggered by `eight_goal.md` (v0.3 Adaptive Coding Runtime) +
> `te_goal.md` (v0.3.1 Runtime Truth). Method: claims verified against
> real source. Updated 2026-07-24.

## Real call chain (current — v0.3.1)

```
user input → CLI/REPL (bin/ovogogogo.ts)
  → resolveApiEnvironment() picks provider (env > wizard > minimax/openai)
  → if --model present: engine.setModelByUser(config.model) [sticky override]
  → ExecutionEngine → RuntimeCoordinator.run()
    → boot() (modules, system prompt, ExecutionContext, toolContext)
    → [loop]
       → check_abort → budget_check
       → collectRoutingSignals → router.route → router.applyRoutingDecision
         (real 11-signal schema; failureEscalationThreshold participates;
          budget allocation applied to maxOutputTokens)
       → module_iteration (single-track Critic, modelClaimingCompletion-aware)
       → llm_call
         → ModelGateway.call() [isRetryableProviderError → onProviderError → router.nextFallback]
         → StreamConsumer.consume()
         → recordUsage → costTracker.addUsage + modelRouter.recordCall(profileId, ok, latencyMs, usage)
       → control_messages (ControlMessageLog → renderForProvider → clear)
       → parse_response → tool_execution
         → ToolScheduler (claims-based partition) → ToolExecutor
    → completion: stop_sequence → evaluateCompletion
      → 6-state verdict (completed|partial|blocked|failed|cancelled|exhausted)
      → RegistryRun transitions to succeeded|blocked|cancelled|failed
      → COMPLETION_EVALUATED / COMPLETION_REJECTED events emitted
```

## Capability status (verified, v0.3.1)

| Capability | Status | Evidence |
|---|---|---|
| ProviderAdapter owns model I/O | ✅ done (v0.2) | `src/core/model/modelGateway.ts` delegates to adapter |
| ResourceScheduler sole concurrency authority | ✅ done (v0.2) | partition claims-based |
| AgentTool cancel aborts child | ✅ done (v0.2) | runId→abort map |
| CommandRunner | 🟡 partial | `runVerification` migrated; ~30 exec sites remain |
| Control messages separate from user history | ✅ done (v0.3.1) | `ControlMessageLog` + `InternalControlMessage` typed channel |
| claims coverage | 🟡 partial | 6/27 tools; broadening is mechanical |
| Unified cancellation | 🟡 partial | bash/agent/bgTask yes; loopEngine has 0 AbortController |
| Adaptive model routing | ✅ done (v0.3.1) | `ModelRouter` + `RoutingSignalCollector` (11-signal schema) |
| RoutingSignalCollector | ✅ done (v0.3.1) | `src/core/model/routingSignalCollector.ts` |
| ProviderRuntimeBinding / ModelRuntimeManager | ✅ done (v0.3.1) | `src/core/model/modelRuntimeManager.ts` |
| Provider fallback (real, with retryable classifier) | ✅ done (v0.3.1) | `ModelGateway.onProviderError` + `Router.nextFallback` |
| Stall / no-progress detection (sliding window) | ✅ done (v0.3.1) | `ProgressMonitor.detectABABPattern` + patch-hash |
| Completion contract (6 states) | ✅ done (v0.3.1) | `evaluateCompletion` |
| TaskGraph per-runId isolation | ✅ done (v0.3.1) | `TaskGraphStore` |
| Adaptive (risk-triggered) Critic | ✅ done (v0.3.1) | `shouldInvokeCritic` + `modelClaimingCompletion` |
| Coding Eval (15+ cases) | ✅ done (v0.3.1) | `evals/wiring-smoke` + `evals/deterministic-runtime` |
| EventStore atomic/idempotent | 🟡 partial | JSONL append; SQLite deferred |
| Native Anthropic / Gemini adapters | ❌ missing | single-transport mode (cross-provider rejected at config) |

See `docs/V0_3_1_RUNTIME_TRUTH.md` for the full capability matrix with
entry files, key classes, real call sites, and tests.

## What this round implements (real + tested)

v0.3.1: 12 P0/P1 items from `te_goal.md`:

- ModelRouter three-way split (setModelByUser / applyRoutingDecision / clearModelOverride)
- ProviderRuntimeBinding + ModelRuntimeManager + cross-provider validation
- RoutingSignalCollector (full 11-signal schema)
- Provider fallback with retryable-error classifier
- CompletionContract 6-state schema
- TaskGraphStore per-runId isolation
- InternalControlMessage typed channel
- ProgressMonitor sliding window (A→B→A→B + patch hash)
- Typed events (19/19 spec events)
- `/trace` / `/why` / `/progress` + duplicate-command detection
- Deterministic eval matrix (25 cases)
- `docs/V0_3_1_RUNTIME_TRUTH.md`

## Deferred (honest reasons)
- Native Anthropic / Gemini adapters (single-transport mode for now)
- Stream-timeout fallback (cannot replay partial text)
- SQLite EventStore (NDJSON for now)
- Full /trace `<runId>` `--json` from EventStore (typed events are in place; JSON marshalling is P2)
