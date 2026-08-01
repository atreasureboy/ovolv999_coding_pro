# ADR-015: Permission decision audit log (R11)

## Context

R9 (ADR-013) established the 5-layer permission flow:

```
Layer 1: toolPolicy           (structural pre-check)
Layer 2: gateByPermissionMode (coarse mode gate)
Layer 3: glob engine          (priority-sorted default rules)
Layer 4: permissionManager    (user rules + mode behavior)
Layer 5: requestPermission    (UI prompt)
```

R10 (ADR-014) made the user-facing rules configurable via settings.json
and `/permissions`. But neither R9 nor R10 added observability —
every permission decision was invisible to the audit log. A user
could not answer:

- "Why was that Bash command allowed?"
- "Did the rm -rf actually get caught by Layer 3, or did it fall
  through to Layer 4?"
- "Did the user re-prompt, or was the session cache hit?"

R11 closes this gap by emitting a `permission_decision` EventLog entry
at every layer that makes a decision. The events are:

- **Forensic**: every allow/deny/ask is recorded with reason + ruleId
- **Layer-attributed**: the source field names which layer decided
- **Replayable**: a `/trace` user can scan events.jsonl and reconstruct
  exactly what happened to a tool call

## Architecture

```
ToolExecutor.execute(callId, toolName, input, ...)
  │
  ├─ Layer 1 (toolPolicy)         ── structural only, no event
  │
  ├─ Layer 2 (mode_gate)
  │    ├─ result === 'deny'  → recordDecision('mode_gate', 'deny', ...)
  │    └─ result === 'allow' → recordDecision('mode_gate', 'allow', ...)
  │
  ├─ Layer 3 (glob_engine)
  │    ├─ result === 'deny'  → recordDecision('glob_engine', 'deny', ruleId)
  │    ├─ result === 'allow' → recordDecision('glob_engine', 'allow', ruleId)
  │    └─ result === 'ask'   → no event (falls through)
  │
  ├─ Layer 4 (permission_manager)
  │    ├─ rule hit deny  → recordDecision('permission_manager', 'deny', ...)
  │    └─ mode says ask  → recordDecision('permission_manager', 'ask', ...)
  │
  └─ Layer 5 (requestPermission)
       └─ user approves → could recordDecision('user_prompt', 'allow', ...)
                          (deferred — UI prompt is non-deterministic,
                           not a decision the engine makes)
```

The `recordDecision` helper is:

```ts
const recordDecision = (layer, outcome, reason, ruleId?) => {
  if (!eventLog) return
  eventLog.append('permission_decision', layer, {
    callId, tool: toolName,
    primaryArg: extractPrimaryArg(input),
    mode: context.permissionMode,
    outcome, reason,
    ruleId: ruleId ?? null,
  })
}
```

Best-effort: if `eventLog` is undefined (e.g. in tests), nothing
happens. The tool path is never blocked by an audit-log failure.

## What each layer emits

| Layer | Outcome | Source label | Reason template |
|---|---|---|---|
| 2 (mode_gate) | deny | `mode_gate` | `mode 'X' denies Y` |
| 2 (mode_gate) | allow | `mode_gate` | `mode 'X' allows Y` |
| 3 (glob_engine) | deny | `glob_engine` | `Permission rule denied: <reason>` (ruleId = matchedRule.id) |
| 3 (glob_engine) | allow | `glob_engine` | `<reason>` (ruleId = matchedRule.id) |
| 3 (session_approval) | allow | `session_approval` | `session-scoped approval cache` |
| 4 (permission_manager) | deny | `permission_manager` | `mode 'X' denies for Y` |
| 4 (permission_manager) | ask | `permission_manager` | `mode suggests ask` |

Layer 1 (toolPolicy) does NOT emit — it's a structural pre-check
(plan mode, agent allowlist), not a permission decision. The
pre-check is logged separately via `TOOL_COMPLETED` events when
the tool returns the policy error.

Layer 5 (requestPermission) does NOT emit — the UI prompt is
non-deterministic from the engine's perspective. The user-facing
decision is captured by the agent's text output and the subsequent
TOOL_COMPLETED event, not by a separate permission event.

## Why this design

The alternative — one event per tool call with the FINAL decision —
would lose the layer-by-layer trail. But the layer-by-layer trail
is precisely what makes the system auditable:

- "Why did this command work in default mode?" — check if Layer 3
  emitted allow (deny-wins invariant)
- "Why did this rule fire when the user has bypassPermissions set?" —
  Layer 3 emitted deny, Layers 2 and 4 didn't run
- "Did the user re-prompt?" — Layer 4 emitted ask, no session_approval

The single-event design conflates these. The 5-layer design is
auditable because the events preserve the order.

## Subscription cost

R11 adds at most 3 events per tool call (one per layer that runs).
This is bounded by the 5-layer flow; in practice 1-2 events per
call. The event schema is intentionally small:

```json
{
  "id": "evt_...",
  "timestamp": "2026-07-31T...",
  "type": "permission_decision",
  "source": "glob_engine",
  "detail": {
    "callId": "c1",
    "tool": "Bash",
    "primaryArg": "rm -rf /tmp/x",
    "mode": "bypassPermissions",
    "outcome": "deny",
    "reason": "Prevent recursive delete",
    "ruleId": "deny-rm-rf"
  }
}
```

Approx 200 bytes per event. For 1000 tool calls/run, that's 200KB
of audit data — well within the rotation budget.

## Tests

`tests/r11-permission-decision-audit.test.ts` (7 tests):

1. Layer 2 (mode_gate) emits allow when bypassPermissions
2. Layer 3 (glob_engine) emits deny on rm -rf, with ruleId
3. Layer 4 (permission_manager) emits deny when user rules deny
4. Layer 3 glob allow + safe command emits allow
5. session_approval cache hit emits allow
6. No eventLog → no decisions recorded (best-effort, no crash)
7. Decision events include mode, primaryArg, ruleId, callId fields

Plus all 4783 existing tests still pass.

## Verification recipe

```bash
# Confirm event type is whitelisted
grep -n "permission_decision" src/core/eventLog.ts

# Confirm each layer emits
grep -n "recordDecision" src/core/toolRuntime/toolExecutor.ts

# Confirm engine wires eventLog into ToolExecutor
grep -n "eventLog: this.eventLog" src/core/engine.ts

# Run the audit tests
npx vitest run tests/r11-permission-decision-audit.test.ts
```

## Future work (R12+)

- **Decision aggregation**: `/trace` could group events by callId
  and show the full layer-by-layer decision chain in one view.
- **Anomaly detection**: a guard could fire `tool.anomaly` events
  when N `deny` decisions happen in a short window (potential
  jailbreak attempt).
- **Permission decision summary**: per-mode statistics — how many
  tools allowed vs denied in this run vs the previous run.
