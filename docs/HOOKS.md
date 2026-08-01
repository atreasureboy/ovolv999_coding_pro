# Hooks

Hooks let you intercept ovolv999 tool calls, modify their arguments, deny them, or inject context into the next LLM round — without forking ovolv999.

## Quick start

Drop a settings file at `~/.ovogo/settings.json` (or `<project>/.ovogo/settings.json`):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "/home/me/.ovogo/hooks/block-dangerous.sh",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

Now every `Bash` call will spawn `/home/me/.ovogo/hooks/block-dangerous.sh` and read its decision before executing.

## Hook events

| Event | When it fires | Input fields |
|---|---|---|
| `PreToolUse` | Before any tool executes | `tool_name`, `tool_input`, `tool_use_id` |
| `PostToolUse` | After a tool succeeds | `tool_name`, `tool_input`, `tool_result`, `tool_use_id` |
| `PostToolUseFailure` | After a tool throws | `tool_name`, `tool_input`, `error`, `tool_use_id` |
| `UserPromptSubmit` | When the user submits a prompt | `prompt` |
| `SessionStart` | At engine boot / session resume | `source?` |

All events also receive `session_id` and `cwd`.

## Matchers

The `matcher` field controls which event payloads trigger the hook. Three forms:

- `"Bash"` — exact tool name match
- `"*"` — match everything
- `"/regex/"` — regex (JavaScript syntax) against the candidate string

Matcher absence matches everything. For `PreToolUse`/`PostToolUse` the candidate is `tool_name`; for `UserPromptSubmit` it's the prompt text.

## Hook output

A hook writes a JSON object to stdout. The runtime parses it and uses these fields:

```json
{
  "continue": true,
  "stopReason": "optional explanation",
  "decision": "approve",
  "reason": "optional explanation",
  "systemMessage": "shown to the user",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "blocks rm -rf",
    "updatedInput": { "command": "ls" },
    "additionalContext": "this command was blocked by team policy"
  }
}
```

Field reference:

| Field | Effect |
|---|---|
| `decision: "approve"` | allow the call (default) |
| `decision: "block"` | deny (alternative to `permissionDecision: "deny"`) |
| `hookSpecificOutput.permissionDecision: "allow"` | allow (same as no output) |
| `hookSpecificOutput.permissionDecision: "deny"` | deny with `permissionDecisionReason` |
| `hookSpecificOutput.permissionDecision: "ask"` | prompt the user for confirmation |
| `hookSpecificOutput.updatedInput` | replace the tool input before execution |
| `hookSpecificOutput.additionalContext` | inject text into the next LLM round (does NOT appear in user history) |

For `PostToolUse` / `PostToolUseFailure` / `UserPromptSubmit` / `SessionStart`, the supported `hookSpecificOutput.additionalContext` field injects context the same way.

## Behaviour

- **Multiple hooks for the same event run in parallel.** All decisions are aggregated: any `deny` short-circuits the call; any `ask` triggers a user prompt; the first `updatedInput` wins; all `additionalContext` is concatenated.
- **Per-hook timeout** is in seconds; default 60s. On timeout the child process is killed and the hook is treated as a non-blocking error.
- **AbortSignal propagation** — if the user hits Ctrl+C mid-tool, in-flight hooks are killed.
- **Failures are non-blocking** — a hook that crashes or exits non-zero is logged via the legacy `IHookRunner.runPreToolCall` path (telemetry) and the tool proceeds as if no hook had run.
- **Output cap** — stdout is capped at 1 MB to prevent OOM.
- **No user-visible pollution** — `additionalContext` is delivered to the next LLM round via the `ControlMessageLog` and then immediately cleared, so it never enters the user's conversation history.

## Examples

### Block `rm -rf` in Bash

`~/.ovogo/hooks/block-rm.sh`:

```bash
#!/usr/bin/env bash
input=$(cat)
cmd=$(echo "$input" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("command",""))')
if echo "$cmd" | grep -q '\brm\s+-rf\b'; then
  cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "rm -rf is forbidden by team policy"
  }
}
EOF
fi
```

### Auto-format files after Edit

```json
{
  "hooks": {
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

### Log every Bash invocation to syslog

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "logger -t ovolv999 -p user.info \"Bash invoked\"",
            "timeout": 2
          }
        ]
      }
    ]
  }
}
```

### Inject policy reminder before every tool call

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"additionalContext\":\"[policy] Never write directly to /etc or /usr.\"}}'"
          }
        ]
      }
    ]
  }
}
```

## Debugging

- Set `OVOGO_LOG=debug` to see per-hook execution logs.
- The `legacyResults` array returned by `IHookRunner.runPreToolCall` is emitted as `tool_call` events in the EventLog; check `runs.jsonl` for hook failures.
- Hook stdout that doesn't parse as JSON is treated as informational text and surfaced via `result.rawStdoutPreview`.

## Limitations

- No prompt-based hooks yet (UI affordance needed).
- No HTTP hooks (no network auth surface yet).
- No async hooks (`{async: true}`) — synchronous blocking with timeout only.
- Settings reload requires a process restart (no live reload).
- Hooks cannot themselves call ovolv999 tools (the child process has no LLM access).
