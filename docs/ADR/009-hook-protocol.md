# ADR-009: Hook Protocol (PreToolUse / PostToolUse)

## Context

Claude Code's hook protocol gives users a way to extend the runtime without modifying ovolv999 itself: each tool call can be intercepted by a user-defined script that returns a permission decision (allow / deny / ask), modifies the input, blocks the call, or injects additional context into the next LLM round. The protocol uses JSON over stdin/stdout so users can write hooks in any language — `bash`, `node`, `python`, etc.

We want this in ovolv999 because:

- The existing `IHookRunner` is fire-and-forget observation only. There's no way to **deny** a tool call, **modify** its arguments, or **inject context** based on what the tool is doing.
- Some workflows need runtime checks we can't hard-code (e.g. "block `Bash` commands that touch `/etc`", "auto-format files after `Edit`", "log every `Bash` invocation with a timestamped tag").
- The existing `IHookRunner` lives in the engine config but has no concrete default implementation, so it's effectively dead code today.

## Options

1. **No hook protocol** — keep the current fire-and-forget observation. Rejected because the existing `IHookRunner` is dead weight without the protocol.

2. **In-process JavaScript hooks** — users register functions via `ovogo.config.ts`. Rejected because (a) requires users to learn our config surface, (b) makes hooks brittle to TypeScript changes, (c) blocks common ops scenarios where users want a one-liner shell command.

3. **JSON stdin/stdout child-process protocol** (chosen) — same shape as claude-code. Users drop a script in `~/.ovogo/settings.json` and the runtime spawns it per tool call. Hooks can be written in any language; failures are non-blocking; the protocol is documented and stable across versions.

## Choice

### Wire protocol

Each hook is a child process. The runtime writes a single JSON object to stdin (the `HookInput`) and reads stdout (a JSON `HookOutput` or free-form text).

`HookInput` (one of):

```ts
{ session_id, cwd, hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id }
{ session_id, cwd, hook_event_name: 'PostToolUse', tool_name, tool_input, tool_result: { content, is_error }, tool_use_id }
{ session_id, cwd, hook_event_name: 'PostToolUseFailure', tool_name, tool_input, error, tool_use_id }
{ session_id, cwd, hook_event_name: 'UserPromptSubmit', prompt }
{ session_id, cwd, hook_event_name: 'SessionStart', source? }
```

`HookOutput` (any subset):

```ts
{
  continue?: boolean
  stopReason?: string
  suppressOutput?: boolean
  systemMessage?: string
  decision?: 'approve' | 'block'
  reason?: string
  hookSpecificOutput?: {
    hookEventName: 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'SessionStart'
    permissionDecision?: 'allow' | 'deny' | 'ask'          // PreToolUse only
    permissionDecisionReason?: string                        // PreToolUse only
    updatedInput?: Record<string, unknown>                   // PreToolUse only
    additionalContext?: string                               // any event
  }
}
```

### Settings format

`~/.ovogo/settings.json` (or `<cwd>/.ovogo/settings.json`):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "/home/me/.ovogo/hooks/block-rm.sh", "timeout": 5 }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit",
        "hooks": [
          { "type": "command", "command": "prettier --write", "timeout": 30 }
        ]
      }
    ]
  }
}
```

`matcher` is optional (omit for "match everything"). String forms supported: exact name, `*` wildcard, or `/regex/` for regex. Project settings override user settings; both are merged.

### How `PreToolUse` outcome flows into `ToolExecutor`

`DefaultHookRunner.runPreToolUse` runs all matching hooks in parallel and returns an array of `PreToolUseOutcome`. The executor:

- If ANY outcome has `decision: 'deny'` → short-circuit to `ToolResult { isError: true, content: reason }`.
- If ANY outcome has `decision: 'ask'` → prompt the user (via existing `requestPermission` callback). If the user denies, same as deny.
- If ANY outcome has `updatedInput` → use the FIRST non-empty one as the new tool input.
- All `additionalContext` strings are concatenated and stored on `ToolContext.hookContext` for the next LLM call (via the existing `ControlMessageLog` mechanism, which `renderForProvider()` then immediately `clear()`s — keeping user history clean).

This ordering mirrors claude-code: deny short-circuits before permission prompt, modified input is applied before execution, and additional context never enters the user-visible transcript.

### Lifecycle hooks we DON'T support yet

To stay within scope for v0.5.x:

- **Prompt-based hooks** (`{type: 'prompt'}`): deferred — needs an interactive prompt UI in the REPL.
- **HTTP hooks**: deferred — adds network dependencies and a new auth surface.
- **Async hooks** (`{async: true}`): deferred — synchronous blocking with timeout covers 90% of use cases. The `executeHookCommand` API is async, so we can layer this in later.
- **Additional hook events** (Notification, Stop, SubagentStart, etc.): deferred — out of scope for v0.5.

### Backward compatibility

- `IHookRunner.runPreToolCall` etc. now return `HookResult[] | Promise<HookResult[]>` (was `HookResult[]`). Existing sync implementations keep working.
- `IHookRunner.runPreToolUse?` and `runPostToolUse?` are optional. If a runner only implements the legacy methods, the executor falls back to fire-and-forget observation.
- `ToolContext` gains `hookContext?: string` for executor-internal use. Tools never read it directly — the executor sets it, the next LLM call reads it (via the executor passing it to `ControlMessageLog` before the call).

## Rejected

- **In-process hooks** (`config.hooks = {PreToolUse: (input) => Promise<PreToolUseOutcome>}`): simpler implementation, but couples hook authoring to TypeScript and makes hooks fragile to refactors.
- **Single hook per event**: forces users to write a meta-hook that fans out. The matchers-list-of-hooks shape (the current choice) composes naturally — each matcher matches independently, all matched hooks run in parallel, and any deny wins.
- **Always-on hooks**: by default no hooks fire. Users opt in by adding `hooks` to their settings.json. This keeps v0.5.x behaviour identical for users who don't write hooks.
- **Blocking the LLM call on hook error**: a hook that crashes must NOT break the runtime. We treat hook failures as non-blocking; the executor continues with default behaviour (allow) and the failure is logged via the legacy `HookResult` telemetry path.

## Consequences

+ Users can write policy-as-code hooks without forking ovolv999.
+ New hook events can be added without changing the executor — only `DefaultHookRunner` and `hookProtocol.ts` need to know about them.
+ Failure isolation: a broken hook degrades gracefully (legacy observation path still runs).
+ Backward-compatible: existing `IHookRunner` implementations (sync or async) keep working.
- Hooks add ~5-50ms latency per tool call (spawn + JSON round-trip). Heavy hooks should be flagged with longer timeouts.
- Hooks are best-effort: there is no transactional guarantee that a hook's decision is preserved across retries, crashes, or process restarts.
- Settings file changes require a process restart (no live reloading yet — `DefaultHookRunner.reload()` exists for future integration).

## Files

- `src/core/hooks/hookProtocol.ts` — typed protocol + `parseHookOutput`
- `src/core/hooks/hooksConfig.ts` — `loadHookConfig`, matchers
- `src/core/hooks/hookExecutor.ts` — `executeHookCommand`, `executeHooksParallel`
- `src/core/hooks/defaultRunner.ts` — `DefaultHookRunner implements IHookRunner`
- `src/core/types.ts` — extended `IHookRunner` with optional outcome methods; new `PreToolUseOutcome` / `PostToolUseOutcome` types
- `src/core/toolRuntime/toolExecutor.ts` — PreToolUse / PostToolUse outcome wiring
- `src/core/runtime/internalControlMessage.ts` — `hook_additional_context` message kind
- `src/core/runtime/coordinator.ts` — `void` markers for async hook calls
- `src/core/context/contextManager.ts` — same
- `tests/core/hooks/hookProtocol.test.ts`, `tests/core/hooks/hooksConfig.test.ts`, `tests/core/hooks/hookExecutor.test.ts` — 32 new tests
