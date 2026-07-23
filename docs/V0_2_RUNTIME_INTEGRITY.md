# V0.2 Runtime Integrity — Architecture Audit & Status

> Triggered by `six_goal.md` (v0.2 Runtime Integrity convergence).
> Method: traced real call chains against source — never README-based.
> All evidence is `file:line`. Updated 2026-07-23 after the Phase 3/4/6.1 fixes.

## 1. Current real call graph

```
CLI (bin/ovogogogo.ts)
 → ExecutionEngine (assembly root + lifecycle, engine.ts)
   → RuntimeCoordinator.run() (loop driver, coordinator.ts)
     → boot() (module boot, prompt, toolContext, ExecutionContext)
     → [loop] check_abort → budget_check → module_iteration
              → llm_call → ModelGateway.call() → StreamConsumer
              → tool_execution → ToolScheduler.schedule()
                  → partitionToolCalls()  [claims-based, post-Phase 3]
                  → executeWithClaims() → ResourceScheduler.acquire()
                  → ToolExecutor.execute() → Tool.execute()
     → moduleManager.runComplete()
   → ExecutionRunRegistry (always present) + RunEventBus (persist-first)

AgentTool.execute() (agent.ts)
 → registry.create(kind='agent', parentRunId=ctx.execution.runId)
 → [modify] worktree fail-closed → factory(childConfig) → childEngine.runTurn()
 → childAborts[runId] = () => childEngine.abort()  [post-Phase 4]
 → 3-phase outcome: worker → verification → delivery(blocked on conflict)

Recovery (engine ctor)
 → recoverNonTerminalRuns(): non-worker→failed, external_worker→recovery-pending-reattach
 → recoverWorkers() (scheduled, in-flight merge): adapter.reattach() or →lost
```

## 2. Nominal architecture vs real execution path

| Claim | Real state | Evidence |
|---|---|---|
| ProviderAdapter takes over model requests | **TRUE post-Phase 1** — ModelGateway delegates to a ProviderAdapter; OpenAI-compatible adapter wraps the SDK. Proven end-to-end with MiniMax M3 (non-OpenAI provider streams + usage through the adapter) | modelGateway.ts, providerAdapter.ts; M3 smoke: text+usage returned |
| Coordinator has no provider branches | **TRUE** — no `if provider===` anywhere | grep clean |
| ResourceScheduler is sole concurrency authority | **TRUE post-Phase 3** — partition is claims-based, legacy whitelist removed | toolScheduler.ts:46-90 |
| Agent cancel terminates running child | **TRUE post-Phase 4** — runId→abort map fires childEngine.abort() | agent.ts:325,864,437 |
| Control messages not disguised as user | **PARTIAL** — compaction summary fixed (system role, no fake ack); coordinator nudges/critic/snip still role:'user' | compact.ts:712, coordinator.ts:314,329,357 |
| Commands unified through CommandRunner | **PARTIAL post-Phase 2** — CommandRunner exists; runVerification migrated; ~30 exec sites remain on allowlist | commandRunner.ts, agent.ts:runVerification |
| EventStore atomic + idempotent | **PARTIAL post-Phase 5** — appendBatch (atomic multi-event) + idempotent eventId dedup; SQLite WAL deferred to v0.3 | executionRunEvents.ts:150,187 |
| max_iterations ≠ succeeded | **TRUE** — maps to `blocked` | coordinator.ts:466-485 |
| Critical event persist failures not swallowed | **TRUE** — JsonlEventStore.append throws on disk-full | gapLFaultInjection.test.ts |

## 3. Parallel / dual implementations

- **Provider layer**: `modelCapabilities.ts` + `providers.ts` define ProviderAdapter/ModelCapabilities, but ModelGateway ignores them → a parallel, unused abstraction. (Phase 1 target.)
- **Worker lifecycle**: WorkerAdapter (start/status/steer/cancel/collect/reattach) is fully implemented on ClaudeCodeTool + AgentTool, but `/workers` slash command talks directly to the manager singleton, bypassing the adapter. Programmatic lifecycle is via the adapter; interactive is direct.
- **EventBus**: always created + persists JSONL, but in-process `.on()` has no production subscriber (extension point).

## 4. Code that bypasses ToolExecutor / permission / ResourceScheduler

- None in the tool-execution hot path post-Phase 3: every tool call goes ToolScheduler → (claims acquire) → ToolExecutor (policy + permission + hooks) → Tool.execute().
- `runVerification` (agent.ts) and Loop quality gates call `execSync` directly — outside the tool path (Phase 2 CommandRunner target).

## 5. Direct exec/execSync/spawn sites (Phase 2 CommandRunner scope)

~30 src files call exec/execSync/spawn directly. Categorised:
- **Core infra (legitimate, transport-layer)**: `claudeCodeWorkerManager`, `backgroundTaskManager`, `backgroundSession`, `lspClient`, `claudeCode.ts`, `sshRemote`, `mcpClient`, `daemon`, `sandbox` — these ARE the process managers; CommandRunner would wrap spawn internally.
- **Business logic (migrate to CommandRunner)**: `agent.ts` runVerification, worktree git ops, LoopEngine quality gates, plus `utils/` (doctor, ide, systemHealth, autoUpdater, notifier), `config/`, `ui/` helpers.
- **Proposed allowlist until migrated**: the utils/config/ui helpers (low-risk, user-facing diagnostics). Verification + git + loop gates migrate first.

## 6. Provider-specific logic location

- `modelGateway.ts:103,112` — `stream_options.include_usage` detection (OpenAI-specific) with fallback latch. Belongs in an OpenAICompatible ProviderAdapter (Phase 1).
- `providers.ts` — model→provider detection from name. OK as a registry helper.
- No provider branches in coordinator/gateway beyond the stream_options compat shim.

## 7. Workers with incomplete lifecycle

- **AgentTool** (in-process): start() unsupported (children synchronous), status/collect are status-checks, cancel **now works** (Phase 4), steer queues. Honest stubs matching the synchronous model.
- **ClaudeCodeTool** (tmux): full lifecycle implemented; only `reattach()` has a production caller (recovery). start/status/steer/cancel/collect/wait are test-reachable + adapter-callable but no production orchestrator drives them yet.

## 8. Persistence errors that could be swallowed

- `JsonlEventStore.append` (write-side) throws on failure — NOT best-effort. ✓
- `ExecutionRunRegistry.transition` / `update` calls are wrapped in `try { } catch { /* best-effort */ }` at many sites (coordinator, agent, claudeCode). These are status-machine updates; a failed transition is non-fatal (the run continues) but is logged only via the catch being empty. Phase 5 (EventStore) should make run-state+event atomic so a failed persist is detectable.

## 9. Modification plan (this round — done)

| Phase | Item | Status |
|---|---|---|
| 1 | ProviderAdapter takes over ModelGateway; OpenAI-compatible adapter; config.provider drives selection; **M3 proven end-to-end** | ✅ done |
| 1 | Fix: MiniMax `/v1` rejects the `[1m]` Anthropic suffix → strip it in resolveApiEnvironment | ✅ done |
| 2 | CommandRunner (CommandSpec/CommandResult, spawn + process-tree kill, timeout/abort/output limits); runVerification migrated | ✅ done |
| 3 | Claims-based partition; remove LEGACY_CONCURRENCY_SAFE_TOOLS | ✅ done |
| 4 | AgentTool cancel truly aborts child (runId→abort map) | ✅ done |
| 5 | EventStore appendBatch (atomic multi-event) + idempotent eventId dedup | ✅ done (SQLite WAL → v0.3) |
| 6.1 | Compaction summary → system role; remove forged assistant ack | ✅ done |
| 0 | This audit document | ✅ done |

## 10. Modification plan (deferred — v0.3 milestones)

1. **Phase 1 remainder**: a native Anthropic-Messages ProviderAdapter (translates Anthropic SSE → OpenAI chunk shape) so providers that only speak Anthropic-protocol work without an OpenAI-compatible facade. (Today MiniMax/Anthropic-via-/v1 already work through OpenAICompatibleAdapter.)
2. **Phase 2 remainder**: migrate the remaining ~30 exec sites (worktree git ops, Loop quality gates, utils/config/ui helpers) to CommandRunner — they're on the allowlist in §5.
3. **Phase 5 remainder**: SQLite WAL EventStore backend (run-state + event in one DB transaction, schema version, JSONL import) behind the now-clean EventStore interface; wire Registry state-writes to use appendBatch for true state+event atomicity.
4. **Phase 6.1 remainder**: InternalControlMessage type for coordinator nudges / critic / snip so they don't pollute genuine user history.
5. **Phase 7 — Eval**: deterministic end-to-end coding eval with baseline comparison.
6. **Phase 8 — Engineering**: package.json hygiene, GitHub Actions, README Stable/Beta/Experimental labelling.

## 11. Compatibility risks (this round)

- **partitionToolCalls semantics changed**: tools without `metadata.claims` now run serially (previously parallel via whitelist). Production tools that benefit from parallelism (Read/Glob/Grep/Edit/Write/Bash) all declare claims, so valuable parallelism is preserved; claim-less tools (Agent/Todo/etc.) become serial — safer, six_goal-intended. Tests updated.
- **Compaction summary role user→system**: OpenAI accepts system messages mid-history; no alternation break. UI history trimmer keyed on the `[CONVERSATION SUMMARY]` marker, unaffected.
- **AgentTool.cancel**: now has a real side effect (aborts child). No caller relied on the status-only behaviour.

All changes: `tsc 0 err` · `lint 0 err` · full suite green.
