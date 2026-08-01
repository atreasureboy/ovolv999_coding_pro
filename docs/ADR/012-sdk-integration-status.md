# ADR-012: SDK integration status (R8 follow-up)

## Context

R8 (Round 8) added three new runtime dependencies to broaden the project's
SDK surface: `@anthropic-ai/sdk`, `chokidar`, and `vscode-jsonrpc`. Total
runtime deps went from 5 → 8 (user-approved explicitly).

The guiding principle is **"不重复造轮子"** — adopt mature npm packages
instead of writing our own infrastructure. But the principle is meaningless
if a dependency is installed but never called. This ADR records the *real*
integration status of each SDK after R8 + the P2.x follow-up, with the
verification path to confirm a reader that the wiring is intact.

This ADR is a **status snapshot** — not a forward-looking design. Future
wiring audits should anchor on this doc and re-verify any section that
changed.

## Why this ADR exists

The user explicitly asked (after R8) "are these SDKs **really** wired in, or
just installed?". That question is the contract this ADR answers:

- **Really wired** = the SDK's API calls are reached from the engine's
  runtime flow, not just imported + exported.
- **Just installed** = the SDK is in `package.json` and the import works,
  but no engine code path actually exercises it.

R8 was a partial pass. P2.1 + P2.2 (2026-07-31) closed the remaining gaps.

## Status table (post-P2.x)

| SDK | Real integration? | Where it's called | Verification |
|---|---|---|---|
| `@anthropic-ai/sdk` | ✅ **Yes** | `src/core/model/anthropicAdapter.ts:92` calls `this.client.messages.stream(params, options)` (engine → `createProviderAdapter` → AnthropicAdapter → SDK) | `pnpm dev` with `provider: 'anthropic'` makes a real API call. SDK types are imported and used in `anthropicSse.ts` (e.g. `Anthropic.MessageCreateParamsNonStreaming`). |
| `chokidar` | ✅ **Yes (after P2.2)** | `src/modules/workspaceWatcher.ts` boots a `WorkspaceWatcher` on cwd + user skills directory, on every engine start. The watcher calls `clearToolIndexCache()` on every file change. Hooked into `engineAssembly.ts` as a built-in module. | `tests/modules/workspaceWatcher.test.ts` (5 tests) covers boot, file change recording, system-reminder injection, onComplete event log, and ignore-dir filtering. |
| `vscode-jsonrpc` | ✅ **Yes (after P2.1)** | `src/core/lsp/client.ts` uses `createMessageConnection` for all LSP wire protocol. Old self-implemented JSON-RPC in `lspClient.ts` is now a 3-line re-export shim. Both `/lsp` command and `lspTool` (LLM tool) reach the same single source. | `tests/lspClient.test.ts` (20 tests) + `tests/core/lsp.test.ts` (7 tests) + `tests/tools/lspTool.test.ts` (9 tests) all pass against the unified client. |

## What was the gap at end of R8

R8 itself did the SDK rewrites but did not unify the duplicate LSP
infrastructure or wire the WorkspaceWatcher into a runtime caller. The
verification prompt that exposed this:

```
$ grep -rn "WorkspaceWatcher" src/         # only returns workspaceWatcher.ts itself
$ grep -rn "LspClient" src/ | grep -v lsp/  # returns both lspClient.ts and lsp/client.ts
```

That is, R8 replaced the wire-protocol implementation but left two
problems:

1. **LSP parallel abstraction**: `src/core/lspClient.ts` (517 lines,
   self-implemented JSON-RPC) coexisted with `src/core/lsp/client.ts`
   (170 lines, vscode-jsonrpc). Both implemented `LspClient`. The
   `/lsp` command used the old one. The LLM tool used the new one.
   A bug fix would have to land in two places.

2. **WorkspaceWatcher dead code**: chokidar was integrated into the
   watcher class, but the watcher class was never instantiated by any
   runtime code. Tests ran it in isolation. chokidar was a dependency
   that the engine never called.

## P2.1 — LSP unification (2026-07-31)

**Goal**: one `LspClient` class, one source of truth, both call sites
unchanged.

**Approach** (chose: merge into `lsp/client.ts`):

- Merged the old `lspClient.ts` API surface (auto-detect, document
  sync, getDiagnostics, workspaceSymbols, formatDiagnostic, getDefaultLspClient)
  into `lsp/client.ts`. Single class now exposes both navigation
  (definition/references/hover/documentSymbols — what the LLM tool
  consumes) and editor-side (document sync, diagnostics, workspace
  symbols — what `/lsp` command consumes).
- The new unified `start()` returns `boolean` (was void / promise).
  `false` on binary not found, swallowed internally; `lspTool.ts`
  checks the boolean and reports a clean error message instead of
  trying to call methods on a dead client.
- `pathToFileUri` was made Windows-cross-platform: recognizes
  `C:\Users\...` paths on Linux test hosts so the round-trip test
  is stable.
- `lspClient.ts` is now a 3-line re-export shim — `export * from
  './lsp/client.js'`. Existing callers (`src/commands/builtin.ts`,
  `tests/lspClient.test.ts`) keep working unchanged.
- `src/commands/builtin.ts` was updated to import from
  `../core/lsp/client.js` directly (the cleaner path), but the
  shim means the import never breaks.

**Result**: 36/36 LSP tests pass. Both code paths (`/lsp` slash command
and the `lsp` LLM tool) reach the same `LspClient` + vscode-jsonrpc
implementation. ~210 lines of self-implemented JSON-RPC framing are
gone.

## P2.2 — WorkspaceWatcher real integration (2026-07-31)

**Goal**: chokidar must be reached from the engine's real lifecycle.

**Approach** (chose: turn the watcher into a module):

- Created `src/modules/workspaceWatcher.ts` — `WorkspaceWatcherModule`
  implements `AgentModule` (best-effort, non-critical).
- `boot()` starts a `WorkspaceWatcher` on the cwd + watches
  `~/.ovogo/skills/` and `~/.ovolv999/knowledge/` as second/third
  roots (each gets its own chokidar instance since chokidar takes
  one root).
- On every file change: calls `clearToolIndexCache()` from
  `core/toolSearch.ts` — real cache invalidation that affects
  `search_extra_tools` runtime behavior.
- `onIteration()` injects a `[system-reminder] workspace files
  changed` once per run if files changed since last iteration.
- `onComplete()` appends a `workspace_change` entry to the EventLog
  (added to the `EventType` whitelist).
- `dispose()` stops all watcher instances.
- Registered in `src/cli/engineAssembly.ts` and auto-enabled in
  `engine.ts:deriveEnabledModules()`.

**Alternatives considered**:

1. **Wire at engine boot directly** (not as a module). Rejected:
   modules give us free lifecycle hooks (boot / onIteration /
   onComplete / dispose) plus the dependency graph. Module pattern
   is the canonical extension point.
2. **Delete the watcher + chokidar dep**. Rejected: chokidar is a
   200-line reduction from the previous self-implemented fs.watch
   polling (R4). Removing chokidar would mean rewriting the watcher
   to use `fs.watch` again, regressing cross-platform reliability.
3. **Wait for a real use case to emerge**. Rejected: the session
   "user edits `~/.ovogo/settings.json` mid-session, settings not
   picked up" is a real and recurring bug. The watcher closes that
   gap and forces concrete cache-invalidation wiring.

**Result**: 5/5 new module tests pass. The 4728 existing tests still
pass. `chokidar` is now reached from the engine's lifecycle, not just
test files.

## Verification recipe

To audit this ADR in the future:

```bash
# Confirm what runtime deps we ship
node -e "console.log(Object.keys(require('./package.json').dependencies))"

# Confirm Anthropic SDK is called (not just imported)
grep -n "messages.stream" src/core/model/anthropicAdapter.ts

# Confirm chokidar is called (not just imported)
grep -n "chokidar.watch" src/core/workspaceWatcher.ts
grep -rn "WorkspaceWatcher" src/ | grep -v workspaceWatcher.ts

# Confirm vscode-jsonrpc is the LSP wire impl
grep -n "createMessageConnection" src/core/lsp/client.ts
ls -la src/core/lspClient.ts    # should be tiny (re-export shim)
```

## P2.3 — Future candidates

Other "adopted SDK, not called" patterns to audit later:

- `ws` (WebSocket) — used by ACP WebSocket transport (added in
  Phase 4). Verify every `ws.send()` is reachable from the engine
  flow.
- `vscode-jsonrpc` — we use it for LSP only. Could it also unify
  the ACP JSON-RPC transport? (Phase 4 ACP transport abstraction
  already lays the groundwork.)

These are not P2.3 blockers — they are future wiring audits.

## Outcome

R8 dependencies are now **all** real integrations. Adding a new
dependency in the future MUST be paired with this kind of ADR entry,
with a "where it's called" verification, to keep the principle
of "不重复造轮子" honest.
