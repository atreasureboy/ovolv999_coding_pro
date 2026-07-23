# V0.3 Adaptive Runtime — Architecture Audit & Status

> Triggered by `eight_goal.md` (v0.3 Adaptive Coding Runtime).
> Method: claims verified against real source (not README). Updated 2026-07-23.

## Real call chain (current)

```
user input → CLI/REPL (bin/ovogogogo.ts)
  → resolveApiEnvironment() picks provider (env > wizard > claude > openai)
  → ExecutionEngine → RuntimeCoordinator.run()
    → boot() (modules, system prompt, ExecutionContext, toolContext)
    → [loop] check_abort → budget_check → module_iteration(critic)
              → llm_call → ModelGateway → ProviderAdapter → stream
              → parse_response → tool_execution
              → ToolScheduler (claims-based partition) → ResourceScheduler.acquire
              → ToolExecutor (policy+permission+hooks) → Tool.execute()
              → CommandRunner (runVerification) / Tool / WorkerAdapter
    → completion: stop_sequence → succeeded | max_iterations → blocked | error → failed
```

## Capability status (verified)

| Capability | Status | Evidence |
|---|---|---|
| ProviderAdapter owns model I/O | ✅ done (v0.2) | modelGateway.ts delegates to adapter; M3 proven |
| ResourceScheduler sole concurrency authority | ✅ done (v0.2) | partition claims-based; legacy whitelist removed |
| AgentTool cancel aborts child | ✅ done (v0.2) | runId→abort map |
| CommandRunner | 🟡 partial | exists + runVerification migrated; ~30 exec sites remain (allowlist) |
| Control messages separate from user history | 🟡 partial | compaction fixed; coordinator nudges/critic/snip still role:user |
| claims coverage | 🟡 partial | 6/27 tools; Read/Edit/Write/Grep/Glob/Bash only |
| Unified cancellation (AbortSignal everywhere) | 🟡 partial | bash/agent/bgTask yes; **loopEngine has 0 AbortController** (can't abort runaway loop) |
| **Adaptive model routing** | ❌ missing | only manual --model//model; autoClassifier classifies tool risk, NOT model | 
| **Stall / no-progress detection** | ❌ missing | loop relies on model self-reporting "stuck"; no real progress signal |
| **Completion contract** | ❌ missing | any stop_sequence → succeeded; model can self-declare done |
| TaskGraph | ❌ missing | linear model→tool→model loop only |
| Adaptive (risk-triggered) Critic | ❌ missing | fixed every-N-turns critic |
| Coding Eval | ❌ missing | module tests only, no end-to-end task eval |
| EventStore atomic/idempotent | 🟡 partial | appendBatch + eventId dedup (v0.2); SQLite deferred |

## Confirmed gaps this round targets
1. **Model routing is manual-only** — no complexity/budget/failure-driven selection, no auto-fallback. (Phase 2)
2. **No stall detection** — long runs can loop on failure / declare done prematurely with no Runtime guard. (Phase 4)
3. **No completion contract** — model self-declaration suffices to mark succeeded. (Phase 4)
4. **No real Coding eval** — can't quantify agent quality. (Phase 6)

## What this round implements (real + tested)
- **Phase 2** — config-driven ModelRouter: ModelProfile/RoutingDecision, complexity/budget/failure routing, `/route` + `/models`, manual override priority, provider fallback that never re-runs side-effectful tools, routing events.
- **Phase 4** — ProgressMonitor + StallDetector (soft/hard stall → strategy change) + CompletionContract (gate completion on acceptance+verification+no-running-children).
- **Phase 6** — minimal deterministic eval harness (fixture + runner + baseline + scripts).

## Deferred (honest reasons)
- **Phase 1.1 full CommandRunner migration**: ~30 sites; extending incrementally, not blocking. runVerification (the verification gate) already migrated.
- **Phase 1.2 remaining control-msg sites** (coordinator nudges/critic/snip): needs an InternalControlMessage type threaded through the provider boundary — larger surface; compaction (worst offender) already fixed.
- **Phase 1.3 claims completeness**: adding claims to the remaining ~21 tools is mechanical but broad; concurrency correctness is already guaranteed by ResourceScheduler.acquire (partition is an optimisation).
- **Phase 3 TaskGraph**, **Phase 5 adaptive Critic**, **Phase 7 /trace//why + ADR + INTERVIEW_DEMO**, **Phase 8 SQLite**: each is a multi-day effort; deferred to keep this round's slices fully-tested-and-real rather than stubbed.
