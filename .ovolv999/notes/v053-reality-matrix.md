# v0.5.3 Reality Matrix (pre-repair)

Each row says: where the user enters, what production code calls
it, what state changes, what's observable, and whether an end-to-end
test covers the real main chain.

| Capability | User entry | Production caller | State source | Observable | E2E test | Status |
|---|---|---|---|---|---|---|
| **RepoStatsService** | Engine boot → Coordinator signal collection | Engine constructs, passed to Coordinator; WorkspaceWatcher creates a SECOND instance; AtSymbolPicker creates a THIRD | Per-instance cache, no shared invalidation | router signals | unit only | **broken** (3 instances, no shared invalidation) |
| **RepoMapService** | Engine constructs | none | internal cache | none | unit only | **not wired** |
| **ContextBudgetSnapshot** | Coordinator llm_call path | coordinator.ts reads | ContextManager.evaluateBudget | Router reads | unit | **wired but stale** — uses last-turn snapshot |
| **TaskGraph.aggregateImpact** | none — TaskPlan never sets impact | none (4 booleans hardcoded false) | none | none | unit only | **not wired** |
| **Router failure stats** | Coordinator collectRoutingSignals | coordinator.ts emits | ModelRouter counters | Router signals | unit | **wired** |
| **LongTermMemory gate** | memory_write tool | MemoryModule.boot wires | LongTermMemory.record (after-write, best-effort) | dual-write: semantic.jsonl + longterm.jsonl | unit | **broken** — gate-after-write, not gate-before-write |
| **Reflection verified** | ReflectionModule.onComplete | always writes if `reason !== 'error'` and `toolCallCount >= 3` | none — sets `verified=true` heuristically | EventLog | unit | **broken** — no CompletionContract gate |
| **SandboxManager** | Engine boot | none | internal | none | unit only | **not wired**; Bash tool still uses old `wrapCommand`; `linux-landlock`/`windows-jobobject` falsely reported available |
| **execpolicy (C2)** | permissionRules.ts exports | none — Bash tool still uses old `evaluateDefaultGlobRule` path | none | none | unit only | **not wired** |
| **EditFormat (C10)** | editFormat.ts exports | none | none | none | unit only | **not wired** |
| **.mdc rules (C11)** | mdcRules.ts exports | none | none | none | unit only | **not wired** |
| **AtSymbolPicker (C12)** | atSymbolPicker.ts exports | none — ToolRegistry never registers it | none | none | unit only | **not wired** |
| **Architect/editor (C13)** | architectMode.ts exports | none — no slash command | none | none | unit only | **not wired** |
| **inheritedConfig (C3)** | coordinator.ts constructs | Engine never supplies it | none in production | unit | **not wired** (Engine doesn't pass deps.inheritedConfig) |
| **.ovolv999ignore (C7)** | walkRepo | yes — RepoStatsService honors it | cache | unit | **wired but isolated** (only RepoStats reads; RepoMap ignores) |
| **maybeCompactWithRetry (C8)** | compact.ts exports | none — ContextManager.evaluateBudget still calls maybeCompactWithInvariants | n/a | unit | **not wired** |
| **RuntimeErrorInfo** | runtimeError.ts exports | only `categorizeProviderError` is referenced by tests | none | unit | **not wired** |

## Actions (v0.5.3 in priority order)

**P0 (production bugs):**
- RepoStats ESM + honest empty/unreadable/failed distinction
- RepoStats single shared instance across Engine + Watcher + Router + AtSymbolPicker (remove AtSymbolPicker if it stays unwired)
- Memory gate as the only write path; semantic.jsonl becomes a derived read-only view
- Reflection verified = CompletionStatus=completed + Reviewer pass + evidence + no verification.failed + no unresolved
- Sandbox: honest backend declaration; only Linux-bwrap (or macos-seatbelt) reported available

**P1 (typo-only state):**
- Router reads fresh-turn snapshot
- TaskPlan impact: real entry point OR delete the aggregate
- Router per-Profile failure attribution
- RuntimeErrorInfo: wire or delete

**Cleanup (Stage 7/8 audit):**
- Move unwired pure-function modules to `experimental/`: RepoMap, execpolicy, EditFormat, mdcRules, AtSymbolPicker, Architect, maybeCompactWithRetry
- Keep inheritedConfig (engine wiring is 1 line)
- Delete the AtSymbolPicker instance creation in the picker default constructor (forces DI)

**Verification:**
- Replace `tests/v052GoldenPath.test.ts` with 3 scenarios that go through the full Engine→Coordinator chain
- Upgrade verify-runtime-truth.mjs to catch unwired-claimed modules