# Changelog

All notable changes are documented here. This project follows Semantic Versioning while it remains in the `0.x` development series.

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
