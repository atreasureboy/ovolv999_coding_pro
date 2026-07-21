# Architecture Audit — Engine Refactoring

## Current Engine Responsibilities (20+)

`ExecutionEngine` (1806 lines) currently owns ALL of:

1. OpenAI client creation + retry config
2. Tool registration (createTools)
3. Module resolution (deriveEnabledModules)
4. System prompt building
5. Tool definition filtering (plan mode + sub-agent allowlist)
6. Context budget evaluation (microCompact, snipCompact, maybeCompact, time-based)
7. LLM API call (streaming, stream_options fallback, reactive compact)
8. Stream consumption (thinking tags, tool call accumulation, watchdog)
9. Tool execution (permission, plan mode, hooks, modules)
10. Tool scheduling (partition, parallel/serial, aggregate budget)
11. Tool context building
12. State machine driver (check_abort, budget_check, module_iteration, llm_call, ...)
13. Cost tracking
14. Abort management (hard abort, soft abort, ownership tracking)
15. Plan mode toggling
16. Snip management (queueSnip, applySnipToMessages)
17. Tool result truncation (truncateToolResult, enforceAggregateToolResultBudget)
18. Module lifecycle (boot, onIteration, onToolCall, onComplete, dispose)
19. File history management (pass-through)
20. Background task management (pass-through)
21. Permission management (pass-through)

## Duplicated State

| State | Where it lives | Should live |
|---|---|---|
| planModeActive | engine field + config.planMode | RunState.planMode |
| softAbortRequested/Owner | engine fields | RunState.abort |
| currentTurnAbortController | engine field | RunState (or coordinator local) |
| systemPromptTokens | engine field | ContextManager |
| lastAssistantTs | engine field | ContextManager |
| _consecutiveCompactFailures | engine field | ContextManager |
| _suppressCompactWarning | engine field | ContextManager |
| _resolvedContextWindow | engine field | ContextManager |
| _streamUsageSupported | engine field | ModelGateway |
| pendingSnipCount | engine field | ContextManager |
| moduleBootResults | engine field | ModuleManager (local) |
| allTools | engine field | ToolRegistry |

## Duplicated Control Logic

1. **Plan mode check** — in getToolDefinitions AND executeToolCall (defense-in-depth, but duplicated code not shared function)
2. **Sub-agent filter** — in getToolDefinitions AND executeToolCall
3. **"Should continue" logic** — check_abort state + continuation_check + maxIterations check
4. **Tool result truncation** — engine's truncateToolResult vs snipCompact.snipToolResults vs enforceAggregateToolResultBudget
5. **Read-only/safe command lists** — LEGACY_PLAN_MODE_TOOLS (engine) + getModeBehavior (permissionSystem) + SAFE_PREFIXES (riskClassifier) + safePatterns (bash)
6. **Process tree kill** — backgroundTaskManager vs bash.ts
7. **Abort listener pattern** — agent.ts vs bash.ts vs backgroundTaskManager.ts

## Dead Code

- `src/core/concurrency.ts` — zero production imports
- `src/core/sandbox.ts` — never wired into BashTool
- `src/core/autoCompact.ts` — not imported by engine, thresholds diverge (0.92 vs 0.85)
- `LEGACY_CONCURRENCY_SAFE_TOOLS` — superseded by per-tool isConcurrencySafe()
- `riskClassifier.checkCommandPermission` — unused
- `ToolMetadata.mutatesState/longRunning/requiresNetwork` — set but never read
- `ToolContext.permissionManager` — populated but no tool reads it
- BriefTool/CtxInspectTool/TerminalCaptureTool/WebBrowserTool/PushNotificationTool — exported but not in createTools()

## Compatibility Surface (MUST PRESERVE)

- Constructor: `new ExecutionEngine(config, renderer, client?)`
- `runTurn(userMessage, history, images?)` → `{ result, newHistory }`
- `abort()`, `softAbort()`, `dispose()`
- `getModel()`, `setModel()`, `getCostTracker()`, `getBackgroundTaskManager()`
- `getPermissionManager()`, `isPlanMode()`, `getConfig()` (LIVE ref)
- `exitPlanMode()`, `enterPlanMode()`, `queueSnip()`, `getFileHistory()`
- `partitionToolCalls` export
- Reentrancy guard: concurrent runTurn rejects with specific error text
- `_turnInFlight` lifecycle, ownership-aware abort cleanup
- `ChildEngineLike` conformance (satisfies `{ runTurn, abort, dispose? }`)

## Target Architecture

```
src/core/
├── runtime/
│   ├── types.ts              # RunState, RunPhase, RunEvent, RuntimeResult
│   ├── coordinator.ts        # Main loop driver
│   ├── terminationPolicy.ts  # All termination decisions
│   └── boot.ts               # Boot sequence
├── model/
│   ├── modelGateway.ts       # API call, retry, stream_options
│   ├── streamConsumer.ts     # Stream parsing, thinking, tool_call accumulation
│   └── providerCompat.ts     # Provider-specific handling
├── context/
│   ├── contextManager.ts     # Budget evaluation, compaction orchestration
│   └── toolResultBudget.ts   # Result truncation
├── toolRuntime/
│   ├── toolRegistry.ts       # Registration, lookup
│   ├── toolPolicy.ts         # Exposure + execution policy
│   ├── toolScheduler.ts      # Partition + batch execution
│   └── toolExecutor.ts       # Single tool execution
├── moduleRuntime/
│   └── moduleManager.ts      # Module lifecycle orchestration
└── engine.ts                 # Thin facade
```

## Dependency Direction

```
CLI / UI → Engine facade → RuntimeCoordinator
    → Model / Context / ToolRuntime / ModuleRuntime
    → Base types, storage, adapters
```
