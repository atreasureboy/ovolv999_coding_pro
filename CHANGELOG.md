# Changelog

All notable changes are documented here. This project follows Semantic Versioning while it remains in the `0.x` development series.

## 0.5.3 (unreleased) — Reality Closure

**Stop claiming Done for code that has no production caller.**

v0.5.3 audits every Stage 7/8 module and classifies each by a
4-state vocabulary: **wired**, **implemented**, **experimental**,
**unsupported**. Modules without a real production caller moved to
`experimental/` and their tests were removed.

### Reality repairs (P0)

- **RepoStats ESM**: pure ESM imports, four-state walk outcomes
  (ready/empty/partial/unknown), symlink-loop guard, build-time
  wireRepoStats() guard so Engine is the SOLE constructor.
- **RepoStats instance sharing**: Engine constructs the single
  instance via `wireRepoStats()`; WorkspaceWatcher, Coordinator,
  and RepoMap receive the SAME instance through ModuleBootContext.
- **Memory Gate as single primary write path**: `memory_write`
  passes through `LongTermMemory.record()` BEFORE touching
  `SemanticMemory`; gate failure returns `isError:true` (no more
  silent "audit gate skipped" lies); `allowCodeWithoutCommit`
  default is now `false`.
- **Reflection verified truth**: success entries require
  CompletionStatus=completed + Reviewer pass + verification.passed;
  failed runs can ONLY write `kind:'failure'` entries which never
  feed the SemanticMemory adapter.
- **Sandbox honest backend**: SandboxManager now reports
  `linux-landlock` and `windows-jobobject` as `available:false`
  with explicit reasons ("syscall emitter not shipped",
  "native addon not shipped") instead of falsely claiming support.

### Typo-only state (P1)

- **Context current-turn snapshot**: Coordinator publishes a fresh
  snapshot BEFORE signal collection; snapshot carries `runId` so
  the Router can refuse stale data from a previous turn.
- **TaskPlan impact schema**: structured `impact_scope`,
  `affects_public_interface`, `changes_configuration`,
  `requires_root_cause`, `estimated_files` validated in TaskPlan
  `add`/`update`. Illegal values rejected; legacy callers work.
- **Router per-profile failure**: per-profile circuit state
  replaces the global circuit; Profile A's 5 failures open A's
  circuit while Profile B remains selectable.
- **RuntimeErrorInfo deleted**: zero production callers; the
  abstract and its tests are removed. Provider error
  classification lives in ModelGateway.isRetryableProviderError.

### Stage 7/8 audit (Phase 4)

Five modules had no production caller despite the v0.5.2 "all
thirteen items wired" claim. They moved to `experimental/`:

  C1  RepoMapService
  C10 EditFormat
  C11 .mdc rule loader
  C12 @-symbol picker
  C13 Architect/editor mode

The remaining items (C2/C3/C5/C6/C7/C9) are genuinely wired into
the production main chain; see `verify-runtime-truth.mjs` for
proof.

### Real Golden Paths (Phase 5)

`tests/v053RealGoldenPath.test.ts` — three scenarios spawn the
real CLI against the openaiEchoServer fixture:
  A. engine reaches fixture with streaming tool calls
  B. model skips verification → blocked verdict
  C. 503 on first call → fallback succeeds on second

### Documentation

- `verify-runtime-truth.mjs` upgraded from 7 to 12 checks:
  experimental/ import guard, Memory Gate ordering, Router field
  consumption, TaskImpact schema, absolute test counts.
- `CLAUDE.md`: removed absolute test-count and outdated runtime-dep
  claims; new vocabulary adopted across survey notes and CHANGELOG.

### Final Reality Closure (v0.5.3 → unreleased)

- **Memory Candidate → Promotion**: `memory_write` no longer
  persists during tool execution. It pushes a `MemoryCandidate`
  onto the per-run `RunScopedRuntimeContext`. After CompletionContract
  + Reviewer + verification, `MemoryModule.onComplete` runs
  `decidePromotion()` which promotes candidates only on a fully
  successful run. Failure runs push `kind:'failure', verified:false`
  entries that never enter the success-memory read pool.
- **User source quote verification**: `claimedSource='user_stated'`
  no longer grants verified access. The model MUST provide a
  `source_quote` that the engine verifies via
  `isNormalizedSubstring()` against the original user message.
  Forged quotes → demoted to `agent_inferred` (success runs) or
  dropped (failure runs). The `origin='memory_write:user_stated'`
  shortcut in `LongTermMemory.record()` is removed entirely.
- **RevisionBinding**: every memory write binds to a real revision
  state — git branch+HEAD (clean), git baseCommit+diffHash
  (dirty), or workspaceHash (non-git). No more `repo='memory'`,
  `repo='session'`, or fabricated `sessionRunId`. New
  `src/core/revisionBinding.ts`.
- **LongTermMemory is the read source**: `memory_search` and boot
  relevance retrieval query `LongTermMemory.query()` directly.
  SemanticMemory is kept only for back-reads of legacy data.
- **consolidateSession** rewritten: no longer accepts a fake
  synthetic runId. Reads only verified=`true` records by real
  sourceRunId, fuses them into candidates, routes through
  `decidePromotion()` + `longTerm.record()`. No parallel
  `semantic.write()`.
- **TaskImpact single source of truth**:
  `src/core/taskImpact.ts` exports `TASK_IMPACT_SCOPES` used by
  tool schema, parser, TaskGraph, Router, and tests. Round-trip
  test asserts every schema enum value parses and every
  parser-accepted value is in the schema. `estimated_files`
  schema `minimum` is now `0`.
- **Router state**: `recordRetry` / `totalRetryAttempts` removed
  (no production caller existed). Real `tryAcquireProbe(profileId)`
  / `finishProbe(profileId, success)` lease API. `route()` returns
  a structured unavailable decision when all profiles are open
  (`selectedModel=''`, `reasonCodes=['all-profiles-open', ...]`).
- **RepoStats truth**: Coordinator passes `repoStats.state` and
  exact sourceFileCount. The router never fabricates
  `repoFileCount=100` from `filesTouched*10` again.
- **ContextSnapshot measure/apply split**:
  `ContextManager.measureBudget()` is pure (no LLM, no message
  mutation); `applyBudgetPolicy()` is the mutating step that may
  compact; after compact, the Coordinator re-measures so the
  Router reads post-compaction state. `AbortError` propagates;
  only clearly-recoverable errors are best-effort ignored.
- **Real Golden Path C**: programmatic two-profile test wires
  `model-a` (fail) and `model-b` (succeed), forces Profile A's
  circuit open, re-routes, asserts the Router picks `model-b`,
  emits exactly one ROUTING_FALLBACK_APPLIED, and counters roll up
  to `totalFailures=≥1, totalFallbacksApplied=1`.
- **Runtime-truth verifier extended**: schema-↔-parser
  round-trip checks, `totalRetryAttempts` absence, no
  `semantic.write` outside the gate, esm-runner scripts wired
  into `pnpm check`.

## 0.5.2 (superseded)

Reality Closure — wiring production main chain to the data sources
the routing + completion signals have always claimed to consume.

### Stage 7 — Borrowing from codex / cursor / aider

Three capabilities surveyed and wired, each gated on a real production
caller and a zero-dep implementation:

- **C1 — `RepoMapService`** (borrowed from `aider/repomap.py`):
  token-budgeted, cacheable, refresh-aware (`auto` / `files` /
  `always` / `manual`) file map. Pure TypeScript — no tree-sitter,
  no embeddings, no networkx. Shares the existing `RepoStatsService`
  walk so the cache key uses real file counts.
- **C3 — `RunScopedRuntimeContext.inheritedConfig` + `inheritConfig()`
  + `withConfigOverride()`** (borrowed from codex
  `multi_agents_common.rs`): structural sub-agent config inheritance.
  Children inherit provider / model / sandbox; **cwd and
  permissionMode are locked to the parent** so a child cannot
  silently escape the project root or switch the user's mode choice.
- **C7 — `.ovolv999ignore` + `CodebaseIndex`** (borrowed from
  cursor `.cursorignore`): gitignore-style exclusion file honored
  by `RepoStatsService`. Glob patterns with `*` and `**`, anchored
  (`/leading`) and unanchored forms.

Survey notes: `.ovolv999/notes/codex-cursor-aider-survey.md`.

### Stage 8 — Comprehensive borrowing completion

All deferred items from the Stage 7 survey are now wired, each gated
on a real production caller and a zero-dep implementation:

- **C2 — execpolicy DSL extension** (codex `execpolicy/`): added
  `HostExecutableRule` + `evaluateHostExecutable()` + `strictestWins()`
  + `evaluateBashPolicy()` to `permissionRules.ts`. Canonical
  `forbidden > prompt > allow` aggregation codified as a testable
  pure function.
- **C6 — Memories auto-extract** (cursor "Memories"): the
  `ReflectionModule` now routes every extracted entry through the
  `LongTermMemory` R1 (verification) + R2 (source marking) +
  R5 (conflict merge) gates. Audit-rejected entries are surfaced
  in the EventLog so the LLM-driven learning loop stays honest.
- **C8 — compact retry + fallback** (codex
  `compact_model_fallback.rs` + `compact_remote_v2_attempt.rs`):
  new `maybeCompactWithRetry()` with retry-on-5xx/429 and a
  `fallbackModels` chain. `CompactResult` gained `error` +
  `retryable` fields so wrappers can decide.
- **C9 — landlock/seatbelt/bwrap sandbox manager** (codex
  `sandboxing/{landlock,seatbelt,bwrap}.rs`): new `SandboxManager`
  with per-platform fallback chain (`bwrap → landlock → none` on
  Linux, `sandbox-exec` on macOS, JobObject on Windows). Detection
  is best-effort; the manager surfaces a `fallbackReason` when no
  backend is available.
- **C10 — EditFormat contract** (aider `editor_*_coder.py`):
  new `EditFormat` union (`whole` / `udiff` / `diff` / `editblock`)
  with pure `applyEdit()` + per-format diagnostics. The system
  prompt can now declare which format the model should emit;
  switching the format does NOT change WHICH tools are available,
  only the SHAPE of the model's output.
- **C11 — Cursor `.mdc` rule loader**: new `parseMdcRule()` +
  `loadRules()` + `activateRules()` + `renderForPrompt()`. Loads
  `.ovolv999/rules/*.mdc` (user-level + cwd-level) with the
  Cursor YAML frontmatter shape and the 4 activation modes
  (`always` / `auto` / `agent` / `decisions`).
- **C12 — Cursor `@`-symbol picker**: new `AtSymbolPicker` tool
  + `createAtSymbolPickerTool()`. Resolves `@file` / `@folder`
  / `@codebase` against the existing `RepoStatsService` walk.
  Zero-deps; `@docs` is reserved but not wired (no docs index yet).
- **C13 — Aider architect/editor mode**: new `runArchitectExecutor()`
  + `formatArchitectResult()`. Two-round planner → executor flow
  with separate model profiles. Production caller: future
  `/architect <task>` slash command.

### Tests

Stage 8 adds 47 new tests across 7 new test files
(`tests/compactRetry`, `tests/sandboxManager`, `tests/execPolicyC2`,
`tests/mdcRules`, `tests/atSymbolPicker`, `tests/editFormat`,
`tests/architectMode`). Cumulative targeted test count for v0.5.2:
**240+ tests** across 12+ files, 0 typecheck errors, all 7
`verify-runtime-truth` checks pass.

### Excluded (done before / out of v0.5.2 scope)

- Aider planner-vs-executor model split — done (v0.5.0 multi-agent + C13 helper)
- Cursor 90% auto-compact threshold — done (CLAUDE.md 85%)
- Cursor `@docs` semantic docs — reserved (zero-deps constraint, future round)
- Codex landlock syscalls — kernel detection is wired but the
  actual syscall emitter is deferred (would require a native
  addon, breaking the zero-deps constraint).

### Added

- **`ContextBudgetSnapshot`** (`src/core/context/contextManager.ts`): a
  read-only snapshot published by `ContextManager.evaluateBudget()`
  and read by the routing signal collector. The Router and the
  Coordinator now share the same source for `contextUsageRatio` and
  `budgetRemaining`; no more fabricated `undefined` values.
- **`RepoStatsService`** (`src/core/repoStats.ts`): a cached,
  walk-based repository file counter. The previous `filesTouched * 10`
  proxy is gone — the Router now reads a real `sourceFileCount` with
  `.git`, `node_modules`, `dist`, `coverage`, `session` and worktree
  directories excluded. Cache invalidates via `WorkspaceWatcher` so
  changes do NOT trigger a per-turn re-glob.
- **`TaskGraph.aggregateImpact()`** + `TaskNode.impact`:
  structured impact metadata (scope, affectsPublicInterface,
  changesConfiguration, requiresRootCause, estimatedFiles). The
  Router prefers real impact data over keyword-only heuristics when
  the planner supplies it.
- **Real provider-failure signals**: `ModelRouter` now tracks
  `totalFailures`, `totalFallbacksApplied`, and `totalRetryAttempts`
  via `getRoutingFailureStats()`. The Coordinator wires these into
  `RouterHealthSnapshot` so `/why` and `/route` can explain the
  decision from real data. The signal collector also receives
  `circuitState`, `consecutiveProviderFailures`, and
  `manualOverrideActive`.
- **`LongTermMemory` write gate** wired into `MemoryModule`:
  every `memory_write` tool call now passes through R1 (verification)
  and R5 (conflict-aware merge) gates. R2 source marking is
  satisfied because `origin` carries `memory_write:<source>`. R3
  (commit binding) is currently downgraded to allow pre-existing
  flows; tightening is a future round.
- **`RuntimeErrorInfo`** (`src/core/runtimeError.ts`): unified
  error shape for permission / hook / tool / provider / daemon /
  worker / verification / memory / routing / context / taskGraph
  subsystems. Categorizes provider errors by status + code,
  eliminating string-prefix sniffing in downstream consumers.
- **`scripts/verify-runtime-truth.mjs`**: machine-checkable
  documentation/code consistency. Catches drift between
  `package.json` version vs README, runtime dependency count vs
  CLAUDE.md, EventType whitelist union alignment, PermissionMode
  single-source-of-truth, ADR path existence, and golden-path test
  presence. Wired into `pnpm check` as the final gate.
- **`tests/v052GoldenPath.test.ts`** — 13 golden-path tests
  exercising RepoStatsService walks, TaskGraph impact aggregation,
  ContextManager snapshot lifecycle, RoutingSignalCollector
  pass-through, and RuntimeErrorInfo classification.

### Changed

- The `providerHealth` signal now also carries `circuitState`,
  `consecutiveProviderFailures`, `totalFallbacksApplied`,
  `totalRetryAttempts`, and `manualOverrideActive`. The Router
  uses these to break out of failing chains before they're
  exhausted.
- The WorkspaceWatcher module now invalidates the RepoStatsService
  cache on every recorded change so cached counts reflect the
  current cwd state.
- The `ContextManager.evaluateBudget()` flow publishes its budget
  snapshot BEFORE deciding whether to compact, so any consumer that
  reads via `getBudgetSnapshot()` after the call sees the same
  numbers the compact decision used.

## 0.5.1

- **TF-IDF tool discovery (`search_extra_tools`)** — defer rarely-used tools out of the system prompt and let the model discover them via TF-IDF keyword search. Pure TypeScript implementation, zero deps. See `docs/TOOL-SEARCH.md` and `docs/ADR/008-tfidf-tool-search.md`.
- **Skill search upgraded to TF-IDF** — better multilingual recall and field weighting (name 3.0 / whenToUse 2.0 / description 1.0 / allowedTools 0.3). Public `searchSkills` API unchanged.
- **Hook protocol (PreToolUse / PostToolUse / UserPromptSubmit / SessionStart / PostToolUseFailure)** — JSON-stdin/stdout child-process protocol. Hooks can `deny` / `modify input` / `inject additionalContext` into the next LLM round. Config in `~/.ovogo/settings.json` under `hooks.*`. See `docs/HOOKS.md` and `docs/ADR/009-hook-protocol.md`.
- **Anthropic native adapter** — first-party Messages API via zero-deps `fetch` + SSE. Supports prompt caching and extended-thinking beta headers via `providerOptions.anthropicBeta`. See `docs/ADR/010-anthropic-adapter.md`.
- **ACP WebSocket transport** — `--acp-ws --port 8765` runs the same JSON-RPC 2.0 protocol as stdio, but on RFC 6455 WebSocket so browsers / dashboards / Python can drive the engine. Zero deps. See `docs/ACP-WS.md`.
- **MCP HTTP transport + OAuth 2.1 PKCE** — `McpHttpClient` for HTTP-based MCP servers with `Authorization: Bearer` from `~/.ovogo/mcp-tokens.json`. Tokens auto-refresh 60s before expiry. See `docs/MCP-OAUTH.md`.
- **Provider stubs for Bedrock / Vertex / Foundry** — honest "not wired in this build" error rather than silent fallback to OpenAI compat. Tracked for 0.6.0.

### R8 — SDK upgrade (2026-07-30)

3 new runtime dependencies added (`@anthropic-ai/sdk`, `chokidar`, `vscode-jsonrpc`).
Total deps: 5 → 8. ADR-010 was rewritten in 2026-08 to reflect the SDK-based
implementation rather than the originally-designed zero-deps hand-rolled
fetch/SSE approach.

### R9 — Permission system (2026-07-31)

5-layer permission flow (toolPolicy → mode gate → glob engine → permissionManager
→ UI prompt). `permissionRules.ts` glob engine wired as Layer 3 (R9.2).
7-mode union (`default / acceptEdits / plan / auto / bypassPermissions / dontAsk
/ bubble`).

### R10 — Permission rules user configuration (2026-07-31)

`settings.permissions.rules` loaded into `PermissionManager` at engine boot.
`/permissions` slash command with `list / add <tool> <pattern> <behavior> /
remove <index> / reset / mode <name>` sub-commands.

### R11 — Permission decision audit log (2026-07-31)

`permission_decision` EventLog event emitted at every permission layer
deny/allow decision. Layer attribution in the event detail.

### R12 — `/permissions mode` extended to 7 modes (2026-07-31)

R12 fix: `dontAsk` and `bubble` modes added to `/permissions mode`
allowlist (was legacy 5-mode). `dontAsk` skips UI prompts; `bubble`
sandbox-wraps Bash tool execution.

### R13-R37 — Daemon supervisor (2026-07-31 to 2026-08-02)

`/daemon` slash command wired to a long-running supervisor over Unix socket.
Worker model: addWorker / removeWorker / listWorkers. 28 incremental rounds:
  - R13: `/daemon status|workers|logs` IPC
  - R14: `restart-worker` per-worker action
  - R15: `worker_restart` EventLog entry
  - R16: `restart-worker all` bulk action
  - R17: `daemon restart-worker` ADR documentation
  - R18: `/daemon restart` audit event
  - R19: `restart-worker all` bulk aggregation
  - R20: `concurrency` throttle (clamped 1-16)
  - R21: `tag:foo` selector
  - R22: `tag:foo,bar` multi-tag selector
  - R23: `tag-stats` aggregation
  - R24: `tag-stats` status filter
  - R25: `tag-stats` multi-status filter
  - R26: `tag-stats` bulk filter (tag + status)
  - R27: `restart-worker` bulk filter
  - R28: `tag-stats` exclude-status filter
  - R29: `restart-worker` exclude-status filter
  - R30: `tag-uptime` per-tag aggregate uptime
  - R31: `statusGte` / `statusLte` lifecycle range filter
  - R32: `parentId` tag inheritance (one level)
  - R33: multi-level parent traversal with cycle detection
  - R34: cumulative uptime across restarts
  - R35: `validate` action for parent-graph cycle detection
  - R36: `maxRestarts` policy (default 3, 0 = unlimited)
  - R37: `list-workers sortBy=name|status|createdAt|insertion`
  - R38: `list-workers sortDir=asc|desc`
  - R39: `sortBy=status` name tie-breaker (deterministic)
  - R40: `list-workers limit|offset` pagination
  - R41: `tag-stats limit|offset` pagination

**Breaking change (R40)**: `list-workers` response shape changed from
`data: WorkerEntry[]` to `data: {workers, total, offset, limit}`. All
callers (slash command `/daemon workers`, tests) updated. Documented
in `docs/audit/2026-08-03-architecture-audit.md` Finding 33
(operational regression if not updated).

## 0.5.0

- Added role-aware model assignment to the existing AgentTool child-engine path.
- Added architect, builder, reviewer, utility, worker, and planner capability roles.
- Added explicit `tier: top | secondary` as the model-strength source of truth.
- Added cross-provider worker profiles with environment-referenced API keys.
- Made every default child preset select secondary roles; architect requires a reasoned request from the root main agent.
- Failed closed when a configured secondary profile is unavailable instead of silently using the main model.
- Required architect participation for architecture, cross-module API, migration, security-boundary, and root-cause delegations.
- Made quality capabilities dominate profile selection; cost and speed are only weak tie-breakers.
- Added structured delegation context for goals, constraints, relevant files, decisions, and acceptance criteria.
- Added durable Worker Result handoff with status, changed files, verification, blockers, model attempts, cost, and retained worktree evidence.
- Aggregated child-model token usage into parent session cost accounting.
- Kept worker-only and embedding profiles out of the main-agent router.
- Preserved modified worktrees when a child engine throws before completion.

## 0.4.2

- Closed the first-run readline lifecycle and stdin ownership gap.
- Normalized soft and hard interrupts to a cancelled TurnOutcome.
- Unified permission profiles and enforced TaskIntent-aware write policy.
- Added multilingual deep-task routing and runtime model synchronization.
- Isolated headless JSON stdout from plans, diagnostics, progress, and terminal control.
- Added actionable session corruption diagnostics and `.bak` recovery.
- Standardized package metadata, lockfile, CI, installers, and release commands on pnpm.

## 0.4.1

Golden-path closure: the capabilities behind the v0.4.0 runtime existed but
were never wired end to end. This release wires them, removes the parallel
abstractions and contradictions that made the first-run → task → interrupt →
result → resume path confusing, and adds spawn-level tests proving entry-door
parity. No new major features.

### Breaking

- `--pipe` now runs on the full `ExecutionEngine` (tool execution, routing,
  completion verdicts) instead of a raw single-shot model call. stdout stays
  pure: text mode prints only the answer; json mode keeps the frozen
  `{response, stats: {inputTokens, outputTokens, durationMs}}` envelope used
  by `sshRemote`. Trade-off: engine boot latency. `--pipe` writes no session
  directory and no `runs.jsonl` (`session:false`). The old raw single-shot
  behavior is frozen behind a hidden `--llm-only` flag (not in `--help`),
  which `sshRemote` now uses so its latency contract is unchanged.
- Exit codes are now one ladder shared by every front door (single-task,
  bare-stdin, `--pipe`): completed → 0, any other verdict → 1, API-class
  terminal failures (401/403/429/5xx, ECONN*, rate-limit/timeout) → 2.
  Before this release the classic single-shot doors exited 0 off a dead API
  key or a `failed` verdict; only `--pipe` reported failure to the shell.
- Removed the `/style` command and `core/outputStyles.ts` — a third parallel
  brevity system contradicting the structured-report contract. Mode personas
  and explicit verbosity selection are retained.

### Added

- Config diagnostics (`src/config/diagnostics.ts`): JSON syntax errors with
  line/column, warn-once on stderr (never stdout, preserving the `--pipe`
  output contract), machine-readable `ConfigDiagnostic` records.
- First-run closure: an interactive TTY with no API key enters the setup
  wizard automatically, then validates the provider with a real probe
  (streaming + tool-calling completion via `src/config/providerProbe.ts`)
  and falls through into the main UI without a restart. Non-TTY callers get
  an actionable stderr block and exit 1; the wizard no longer hangs on EOF.
- Corrupt `~/.ovogo/settings.json` no longer crashes `--version` / `--pipe`;
  loaders warn and fall through with defaults. Corrupt project config and
  the seven sidecar loaders warn and continue (CI/`--bg` subprocesses
  survive). Unknown/invalid settings fields warn once instead of being
  silently dropped.
- `ExecutionProfile` (`fast` / `standard` / `deep` / `autonomous`,
  `src/core/effort.ts`): per-turn module gating (`ModuleManager.boot`
  filter — the constructed module set is unchanged, so `standard` behaves
  byte-for-byte like v0.4.0), per-turn `maxIterations` / `maxOutputTokens`,
  `excludedTools` through the existing plan-mode tool-policy seam, sticky
  override via `--profile` and `/profile`, a status-bar chip for non-standard
  profiles, and a `PROFILE_RESOLVED` run event feeding `/why` and the event
  log. `fast` skips Critic/Reflection/TaskGraph/sub-agents for read-only and
  informational turns.
- Session envelope v2: real `TurnOutcome` summaries (status, changed files,
  verification executed/passed, blockers, required next actions, last model,
  duration) persist with the session. `/resume` and session listings show
  the true verdict; v1-era sessions report `unknown` and corrupt envelopes
  report `corrupt` — status is never guessed from "files were edited"
  anymore. v1 → v2 migration preserves message history.
- Completion verdicts now carry real `evidence[]` and `requiredNextActions`
  from the completion contract; the coordinator no longer hardcodes them away.
- Classic frontend grows its first result card (`renderOutcomeCard`, the
  twin of the Ink outcome card) and renders the five-section error card
  exactly once per failure, like Ink.
- Engine assembly extracted to `src/cli/engineAssembly.ts`: every entry mode
  (interactive, single-shot, stdin, `--pipe`, `--bg`, `--loop`) shares one
  assembly, so permission mode, model precedence, and wiring cannot drift
  between doors.
- New test coverage: real-CLI spawn suites against a zero-dependency echo
  fixture (`tests/cli/pipeSpawn.test.ts`, `tests/cli/entrySemanticsMatrix.test.ts`
  — 3 doors × {completed, API 401} + `--model` on the wire), plus
  `engineAssembly`, `firstRunWizard`, `providerProbe`, `configDiagnostics`,
  `configSidecarWarn`, `executionProfile`, `sessionEnvelopeV2`,
  `coordinatorEvidence`, `errorRenderOnce`, `turnOutcomeCard`, `modelBridge`,
  `routingBudgetSameModel`, `systemPromptConvergence`, `parseArgsFix`,
  `streamConsumerProtocol`, `storeOrphan`, `interruptFlow`,
  `registrySingleSource`, `cardRenderCount`.

### Changed

- Interrupt semantics are now what the copy says: first ESC soft-aborts
  (the turn stops at the next boundary; the user's next message continues
  the work; completed steps are not repeated); second ESC force-kills. The
  interrupt overlay no longer outlives the turn. Feedback injection during a
  paused turn remains classic-only and is no longer promised by Ink copy or
  the system prompt.
- Single prompt contract: one structured report block (changes /
  verification / unresolved / next actions) mirroring the outcome card; the
  contradictory "1–3 sentences / one word" brevity directives are gone.
- Model truth in the UI: outcome cards display the model that actually
  answered (last succeeded attempt), the status bar is driven by routing
  events, and same-model routing applies the token budget without emitting
  spurious model-changed events.
- Tool-result attribution is honest: unmatched tool/agent results render as
  visible orphan rows instead of a positional guess (parallel tool
  execution could misattribute tool B's output to tool A). Streams with 2+
  tool calls missing ids log a `protocol_error` event and warn once; a
  single missing id is still silently synthesized for vLLM/Ollama
  compatibility.
- `/help`, the `?` overlay, the slash-autocomplete menu, and the bare-`/`
  listing all consume the single command registry; `/models` comes from
  `modelRouter.listProfiles()`; `--help`'s REPL section is generated from
  the registry at runtime instead of a hardcoded list.
- `parseArgs`: unknown dash flags warn on stderr and are skipped — their
  values no longer leak into the task text; `--max-stdin`, `--no-context`,
  and `--base-url` are honored.
- Error cards reflect reality: the log-trace line points at the actual
  `events.ndjson`, and fabricated "auto-recovery" lines were replaced with
  statements derived from the real model-attempt chain.
- The eight silent session-write catch blocks now share one stderr
  warn-once path.

### Fixed

- The engine no longer renders its own error card mid-turn; exactly one
  frontend catch renders the five-section error card (Ink App, classic
  single-shot/REPL). `runInkRepl` re-throws non-abort errors instead of
  swallowing them into an empty "Stopped · error" line.
- Same-model routing budget bug: the `!==` guard skipped budget allocation
  when routing kept the current model; the budget now applies either way.
- `/resume` status guessing removed (edited-files → "Completed", corrupt →
  "Completed" heuristics deleted).
- Non-TTY stdin no longer deadlocks the first-run wizard.

### Documentation correction

- The v0.4.0 commit message (2ebca70) claimed a hidden `--llm-only` flag,
  wizard provider validation, and a five-section error card. None of those
  existed in the v0.4.0 tree. All three are real as of 0.4.1: `--llm-only`
  is the frozen raw single-shot path, `providerProbe` performs startup
  validation, and the five-section error card renders exactly once on every
  door's failure path.

## 0.3.6

### Reliability

- Bound completion candidates to the active run, goal, acceptance contract, checkpoint sequence, quality gates, TaskGraph, and Worker state.
- Added authoritative provider attempt chains with per-attempt usage, cost, latency, and model attribution.
- Hardened lease ownership with stable process identity, owner tokens, and atomic takeover and release.
- Separated heartbeat liveness from evidence-backed progress and park the runtime after repeated heartbeat persistence failures.
- Restored checkpoints without replaying quality gates already backed by valid evidence.
- Preserved partial, blocked, conflicted, and patch-bearing Worker worktrees for parent recovery.
- Made terminal run outcomes explicit and single-emission.

### Distribution

- Added reproducible npm installs from a committed lockfile.
- Made Unix and Windows updates staged and rollback-safe.
- Added cross-platform CI, dependency automation, package smoke tests, and a tag-driven release workflow.
- Reduced the published package to runtime artifacts and public documentation.
