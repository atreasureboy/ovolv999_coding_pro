# Codex / Cursor / Aider Survey Notes — Final

Compiled from two background-agent reports (Cursor Area 2 + Codex/Aider
three-axis). Each candidate below is gated on: production main-chain
caller (not tests-only), no new state machine / framework / event bus,
compatibility with v0.5.2 surfaces, R1–R6 memory gates if memory is
touched, hook events fire from real paths or are removed, and
`verify-runtime-truth.mjs` stays green.

## Verified candidates

### C1 — Aider-style repo map (aider/repomap.py)

**Pattern**: PageRank over source-file graph (per-import/shared-symbol
edges), cached in `.tags.cache.v3` (legacy `v4` with `tree-sitter-language-pack`),
3 refresh modes (`auto` / `files` / `always` / `manual`), token budget
(`--map-tokens`, default 1k).

**ovolv999 reality**: zero `repoMap`, `pagerank`, `repo_map` references
across `src/`. We have `RepoStatsService` (file count only — added in
v0.5.2 Stage 2.2) but NO semantic map.

**Borrowable**: introduce a `RepoMapService` that builds a token-budgeted
import/symbol graph once per session, with the same 4 refresh modes.
Serves the Router (high-scope edits → bigger context) and the system
prompt (`## Repo Map` block, capped at `--map-tokens`). Production
caller: `Coordinator.llm_call` builds it lazily and passes to the
system prompt builder.

**Constraint**: zero native deps. Use plain TypeScript + the existing
`RepoStatsService` traversal — no `tree-sitter`, no `networkx`.
Heuristic: file→symbol graph extracted by regex + token-aware
truncation, not LLM-generated.

### C2 — Codex execpolicy DSL (prefix_rule + strictest-wins)

**Pattern**: `prefix_rule(pattern, decision, justification, match, not_match)`
with `host_executable(name, paths)`; strictest-wins aggregation
(`forbidden > prompt > allow`).

**ovolv999 reality**: `src/core/permissionRules.ts` has 267 lines of
priority-sorted glob rules (wired in Stage 2.4 / R9.2). Already does
deny-wins. Missing: explicit DSL surface + `host_executable` semantic
+ `match/not_match` refinement.

**Borrowable**: do NOT add a new DSL — that would be a parallel
abstraction. Instead, extend `permissionRules.ts` with `host_executable`
support (Bash tool wraps the binary lookup through it), and document
the `forbidden > prompt > allow` aggregation rule as the canonical
contract. Existing engine already does deny-wins; this is a doc +
shape change, not a new module.

### C3 — Codex sub-agent config inheritance

**Pattern**: sub-agents inherit parent's `provider / approval_policy /
sandbox / cwd`, then layer role-specific overrides.

**ovolv999 reality**: `AgentTool` and `ClaudeCodeTool` both take
`EngineConfig` slices via constructor — config inheritance is implicit
in what the parent hands down. `RunScopedRuntimeContext` was designed
exactly for per-run config isolation in v0.3.2.

**Borrowable**: extend `RunScopedRuntimeContext` with an explicit
`parentContext` reference and an `inheritConfig()` method that
copies provider / permission / sandbox into the child. This makes the
inheritance contract structural instead of accidental. Single-file
change to `runScopedContext.ts`.

### C4 — Aider's planner-vs-executor model split (architect → editor)

**Pattern**: `architect_coder.py` plans, then `editor_*_coder.py` emits
the diff. Different model ids, same edit-format contract.

**ovolv999 reality**: `ModelProfile.roles` already supports
`'main' | 'cheap' | 'long-context' | 'worker'` (added in v0.5.0).
Role-aware multi-agent is already wired (commit `f7ea4b2`).

**Borrowable**: NOT — already done. Mark as completed.

### C5 — Cursor auto-compaction threshold

**Pattern**: Cursor auto-summarizes at ~90% (server-side, fixed,
user-requested configurable).

**ovolv999 reality**: `getCompressionStrategy(pct)` fires snip at 50% /
warn at 70% / compact at 85% (CLAUDE.md "50% snip/70% warn/85% compact").
Already has PreCompact / PostCompact hooks.

**Borrowable**: NOT — already done. Mark as completed.

### C6 — Cursor "Memories" persistent cross-session knowledge base

**Pattern**: extract memories from chat, sidecar-approve before save;
`.cursor/rules/*.mdc` with YAML frontmatter + 4 activation modes.

**ovolv999 reality**: `LongTermMemory` (R1–R6) just wired in v0.5.2
Stage 3 with `allowCodeWithoutCommit: true`. Zero auto-extraction.

**Borrowable**: NOT yet. `LongTermMemory` is the gate, but no extractor
exists. The right next step is a "reflection on verified run"
extractor that fires from the Coordinator's completion path. Skip
until Stage 8 — current scope.

### C7 — Cursor codebase indexing + `.cursorignore`

**Pattern**: background embeddings, `@`-symbol retrieval, 5-min sync,
`.cursorignore` exclusion.

**ovolv999 reality**: TF-IDF tool search (ADR-008) is keyword-scored,
not embedding-based. Zero codebase index. Zero `.ovolv999ignore` /
equivalent.

**Borrowable**: add `.ovolv999ignore` (gitignore-style) wired into
`RepoStatsService` and a new `CodebaseIndex` (TF-IDF over source
files — zero deps). Same refresh modes as C1. Production caller:
system-prompt builder. Two-file change + tests.

### C8 — Codex multi-tier compaction (`InitialContextInjection` + `attempt`)

**Pattern**: pre-turn manual vs mid-turn auto distinction; remote
compaction has retryable `attempt` abstraction; `compact_model_fallback`.

**ovolv999 reality**: `evaluateBudget()` (auto) vs `applySnip()`
(manual /snip) exist as separate paths. No retry abstraction. No
fallback model for compaction.

**Borrowable**: minor — add `compactAttempt` counter and a
`compactFallback` profile selector (use the Router's
`getRoutingFailureStats()` to pick a fallback). Skip until Stage 9.

### C9 — Codex landlock / seatbelt / bwrap OS sandbox

**Pattern**: per-platform OS-level sandbox; stored `.sbpl` profiles;
`denial.rs` / `violation.rs` / `manager.rs` orchestration.

**ovolv999 reality**: bubble mode wraps Bash in bwrap (`bubble` permission
mode in ADR-013). No landlock / seatbelt fallback path. No
`.sbpl` profiles.

**Borrowable**: minor — add `landlock` path alongside bwrap (Linux
fallback when bwrap is not available) and `seatbelt` path for macOS.
This is a 3-file change in `src/core/permissionSystem.ts` and
`src/tools/bash.ts`. Skip until Stage 10 — needs sandbox test
infrastructure.

## Selected for next round (v0.5.2 Stage 7)

| ID | Capability | Files | Effort |
|---|---|---|---|
| C1 | RepoMapService (token-budgeted PageRank-style graph) | new + test | 1-2 days |
| C3 | RunScopedRuntimeContext.inheritConfig() | edit + test | 0.5 day |
| C7 | `.ovolv999ignore` + CodebaseIndex (TF-IDF) | new + edit + test | 1-2 days |

These three:
- Each has a verifiable production caller
- No new state machine / framework / event bus
- All compatible with v0.5.2 surfaces
- C7 doesn't touch memory so R1–R6 don't apply
- All stay within zero-dep constraint
- All keep `verify-runtime-truth.mjs` green

## Excluded (already done or out of scope)

- C4 (planner-vs-executor model split) — done
- C5 (90% auto-compact) — done
- C6 (Memories auto-extract) — LongTermMemory gate in place, extractor deferred
- C8 (compact retry abstraction) — deferred
- C9 (landlock/seatbelt) — deferred

## Not public

- Codex exact auto-compact threshold
- Codex per-tool time/cost budgets
- Aider "Split Repo" sub-agent mode dispatch
- Codex cross-session persistent memory (feature-request only)