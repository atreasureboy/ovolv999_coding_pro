# ADR-039: max-restarts policy (R36)

## Context

R14 (ADR-017) added restart-worker. R34 (ADR-037) added restart
count tracking. R36 adds a **cap** — after N restarts, further
restart attempts are rejected.

The use case is **infinite restart loops**: a worker that crashes
immediately on startup would be restarted forever. Without a cap,
the daemon would run up to the system `max_restarts` (often
systemd's `StartLimitBurst`) but each restart is just a 50ms
timer. The cap protects against:

- Crashing-into-restart loops that waste CPU
- A worker that has fundamental config errors — capping
  surfaces the problem rather than letting it run forever
- "Fenced" workers that have been quarantined but need explicit
  human intervention to restart

## Schema

```ts
{
  action: 'restart-worker',
  payload: {
    workerId: 'worker-...',
    maxRestarts: 3,  // R36: optional, default 3, 0 = unlimited
  }
}
```

Behavior:
- `restartCount < maxRestarts` → ok: true, restart succeeds
- `restartCount >= maxRestarts` → ok: false, error: `Worker <id> has reached max-restarts (N)`
- `maxRestarts = 0` → unlimited (no cap)

## Why not "auto-zero on success"

Auto-resetting the counter on success would make the cap a
"consecutive failure" limit rather than a "lifetime restart" cap.
Both are reasonable but mean different things:

- Consecutive failure: cap protects against crash loops
- Lifetime restart: cap protects against runaway restart traffic

R36 implements lifetime cap. Future round could add
`payload.resetOnSuccess: true` for the consecutive-failure
semantics. Today the lifetime cap is the simpler concept and
covers the most common operational case.

## Validation

- `maxRestarts: 3` → cap at 3
- `maxRestarts: 0` → unlimited
- `maxRestarts: 1` → cap at 1 (only one restart)
- `maxRestarts: 'banana'` → falls back to default 3
- `maxRestarts: -5` → floored to -5, `> 0` check rejects, so unlimited
- `maxRestarts: 999` → cap at 999

## Tests

`tests/r13-daemon-slash-command.test.ts` (+3 R36 tests):

1. **R36: restart-worker respects max-restarts (default 3)** —
   3 successful restarts, 4th fails.
2. **R36: maxRestarts=0 allows unlimited restarts** — 5
   restarts all succeed.
3. **R36: maxRestarts=1 caps at 1 restart** — first succeeds,
   second fails.

Plus all 4846 existing tests still pass.

## Verification recipe

```bash
# Confirm max-restarts policy
grep -n "maxRestarts" src/core/daemon.ts

# Run daemon slash-command suite (R13–R36)
npx vitest run tests/r13-daemon-slash-command.test.ts
```

## Future work (R37+)

- **Reset on success**: `payload.resetOnSuccess: true` for
  consecutive-failure semantics.
- **Restart audit log unification**: emit restart events to
  the engine's EventLog too (currently only the daemon's log).
- **CLI restart path emitting**: `ovolv999 daemon restart <id>`
  from CLI emits a worker_restart event to the engine's EventLog.
- **Cycle prevention at addWorker**: graph validation at
  creation time (currently only via `validate` action).
