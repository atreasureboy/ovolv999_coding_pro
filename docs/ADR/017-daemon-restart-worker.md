# ADR-017: Daemon restart-worker IPC action (R14)

## Context

The `Daemon` class already declared `restart-worker` in its
`DaemonCommand` type union (R13 ADR-016 noted this as a follow-up):

```ts
export interface DaemonCommand {
  action: 'status' | 'stop' | 'ping' | 'health' | 'list-workers' | 'restart-worker'
  payload?: Record<string, unknown>
}
```

But the `handleCommand` switch in `daemon.ts:189` had no `case
'restart-worker'`. A client sending `restart-worker` would hit
`default: return { ok: false, error: 'Unknown action: restart-worker' }`.
The type promised a feature that wasn't implemented — a classic
"契约漂移" (contract drift).

R14 closes this by:

1. Implementing the `restart-worker` case in the daemon switch
2. Validating payload.workerId (string, non-empty)
3. Validating the worker exists (returns ok=false with a clear error
   if not)
4. Atomically resetting the worker's lifecycle state
5. Wiring the slash command `/daemon restart <id>` to the new action

## Lifecycle semantics

The local `Daemon` doesn't actually spawn subprocesses (it tracks
worker metadata only — process management lives in the higher-level
`processSupervisor.ts` that `bin/ovogogogo.ts` wraps). What
`restart-worker` does today is:

- Mark worker `status = 'starting'`
- Update `startedAt = now`
- Schedule a 50ms timer to flip the state to `'running'`
  (simulates the spawn → ready cycle)

This gives callers (CLI tools, slash commands, automation scripts)
a synchronous IPC confirmation that the restart action was processed,
without committing to subprocess semantics that aren't wired yet.

When subprocess spawning lands (future round), this handler becomes
the IPC seam — it spawns the child process and waits for its ready
probe before flipping status to `'running'`.

## Why payload validation matters

Without payload validation, callers could:

- Send `restart-worker {}` — semantic failure (no workerId)
- Send `restart-worker { workerId: null }` — type confusion
- Send `restart-worker { workerId: 123 }` — wrong type

The handler treats each as `ok: false` with a clear error message
so the caller's retry / recovery logic can branch. The error
strings are stable across versions — they're part of the IPC
contract.

## Tests

`tests/r13-daemon-slash-command.test.ts` (+3 R14 tests):

1. **restart-worker IPC action: valid id processes** — real daemon,
   real worker, real `client.send({ action: 'restart-worker', payload: { workerId } })`.
   Verifies the response shape, then waits for the simulated restart
   cycle and re-queries via `list-workers` to confirm the worker
   is back to status `'running'`.
2. **restart-worker without workerId returns ok=false** — exercises
   the payload validation guard.
3. **restart-worker with unknown id returns ok=false with clear error** —
   exercises the worker existence check.

Plus all 4794 existing tests still pass.

## Verification recipe

```bash
# Confirm the action is implemented
grep -n "restart-worker" src/core/daemon.ts

# Confirm the slash command routes through it
grep -n "sub === 'restart'" src/commands/builtin.ts

# Confirm IPC plumbing reaches the daemon
grep -n "restart-worker" tests/r13-daemon-slash-command.test.ts

# Run the daemon slash-command suite (covers R13 + R14)
npx vitest run tests/r13-daemon-slash-command.test.ts
```

## Failure surface

| Input | Result |
|---|---|
| `restart-worker` (no payload) | `ok: false`, error `'restart-worker requires payload.workerId'` |
| `restart-worker { workerId: 123 }` (wrong type) | `ok: false`, error `'restart-worker requires payload.workerId'` |
| `restart-worker { workerId: 'no-such-worker' }` | `ok: false`, error `'Worker not found: no-such-worker'` |
| `restart-worker { workerId: 'w-1' }` (valid) | `ok: true`, data `{ workerId, status, requestedAt }` |

## Future work (R15+)

- **Subprocess side-effects**: when the daemon becomes a real
  process supervisor, `restart-worker` should kill the existing
  child (if pid), spawn a new one, and probe health before flipping
  status to `'running'`. The current 50ms simulated cycle becomes
  the actual spawn → ready probe.
- **`/daemon restart all`**: bulk restart by tag. Each worker
  restart is independent — failures don't block others.
- **Restart audit log**: every restart emits a `worker.restart`
  EventLog entry to the engine's EventLog, but the daemon's own
  log is in `daemon.log`. The two log surfaces should be unified.
