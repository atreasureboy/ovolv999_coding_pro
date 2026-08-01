# ADR-018: worker_restart event in engine EventLog (R15)

## Context

R14 (ADR-017) added `restart-worker` IPC action: the daemon
process atomically resets a worker's lifecycle state and returns
a confirmation. The confirmation lives in the daemon's own log
(`~/.ovolv999/daemon.log`).

But the **engine** has no idea it happened. A user running
`/trace` to replay a session would see:

- Tool calls
- Permission decisions (R11)
- Workspace changes (P2.2)
- Context compactions
- Module flags

…but no daemon lifecycle events. The disconnect is: the daemon
is a separate process with its own log, and the engine's EventLog
is per-session, so daemon-side events naturally wouldn't appear
there.

R15 closes this by emitting a `worker_restart` event from the
**slash command** (which runs in the engine's REPL) when the user
asks for a restart. The slash command's view of the restart is
limited (it only knows the IPC response, not the daemon's internal
state machine), but it captures the user-facing intent: "I
requested a restart of worker X, and the daemon said yes/no".

## Event schema

```json
{
  "id": "evt_<uuid>",
  "timestamp": "2026-08-01T...",
  "type": "worker_restart",
  "source": "daemon_slash",
  "detail": {
    "workerId": "worker-...",
    "outcome": "requested" | "failed",
    "error": null | "<error string>",
    "socketPath": "<path>"
  }
}
```

Three things matter here:

1. `workerId` — what's being restarted (matches the daemon's
   internal ID).
2. `outcome` — `requested` if the daemon accepted the IPC and
   processed the restart, `failed` if the IPC returned ok=false.
3. `error` — the daemon's error string when outcome is `failed`.

`source` is always `daemon_slash` for now. Future R16+ work
might add `source: 'daemon_cli'` when the user runs
`ovolv999 daemon restart <id>` from the CLI directly — the
CLI command would also emit (if it has engine context, which is
trickier since it's a fresh process).

## Why emit from the slash command, not the daemon

The engine's EventLog lives in the engine's session directory.
The daemon is a separate process and can't write to it directly
without forking the EventLog out of the engine. The slash command
is the natural seam:

- It runs in the engine's REPL → has access to the engine's EventLog
- It calls the daemon via IPC → captures the daemon's response
- It records the result for the trace

The downside is that the slash command doesn't see failures that
happen AFTER the IPC response (e.g. the daemon crashes mid-restart).
R17 candidate: have the daemon emit back to the engine via a
notification endpoint. Not in scope for R15.

## Verification

```bash
# Confirm event type is whitelisted
grep -n "worker_restart" src/core/eventLog.ts

# Confirm engine exposes eventLog to slash commands
grep -n "getEventLog" src/core/engine.ts

# Confirm slash command emits
grep -n "worker_restart" src/commands/builtin.ts

# Run the daemon slash-command suite (R13 + R14 + R15)
npx vitest run tests/r13-daemon-slash-command.test.ts
```

## Tests

`tests/r13-daemon-slash-command.test.ts` (+2 R15 tests):

1. **R15: worker_restart event lands in engine EventLog on success** —
   real daemon, real worker, real `client.send`, real EventLog
   capture. Verifies the full chain: slash command → IPC → daemon
   decision → engine EventLog.
2. **R15: worker_restart event records failure on bad id** —
   verifies the failure path also gets audited.

Plus all 4796 existing tests still pass.

## Future work (R16+)

- **`ovolv999 daemon restart <id>` CLI path emits too**: would
  require either (a) starting a stub engine inside the CLI just
  for the EventLog, or (b) the daemon sending a notification to
  the running engine. Both have cost — defer to when CLI restarts
  become a real workflow.
- **`/trace` cross-process indicator**: when a session's trace
  includes daemon events, mark them with a different icon so the
  user can tell which trace lines came from the engine vs the
  daemon.
- **Worker restart rate limit**: if a user restarts the same
  worker N times in M minutes, emit a `worker_restart.spam`
  event — useful for diagnosing stuck/restart-loop workers.
