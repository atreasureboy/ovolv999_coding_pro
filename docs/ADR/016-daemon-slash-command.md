# ADR-016: Daemon slash command real IPC wiring (R13)

## Context

The long-running daemon supervisor was implemented in
`src/core/daemon.ts` (338 lines):

- `Daemon` class with start/stop/handleConnection over a Unix socket
- `DaemonClient` for IPC
- `formatDaemonInfo`, `formatWorkers` for display
- Wired at the CLI level via `bin/ovogogogo.ts:1550-1600`
  (`ovolv999 daemon start/stop/attach/kill/help`)

The CLI path was real. The `/daemon` slash command inside the REPL
was a stub:

```ts
handler: () => {
  return text('Daemon control requires running ovolv999 --daemon. …')
}
```

Just `isDaemonRunning()` + `getDaemonSocketPath()`. No actual IPC.
A user in the REPL couldn't query status, list workers, or tail
logs — they had to exit the REPL and use the CLI. R13 closes this
gap.

## What changed

`/daemon` slash command now:

1. Imports `DaemonClient` via `await import()` (works in both
   test and production runtime)
2. Sub-commands route to the live daemon over the IPC socket:
   - `status` → `client.status()` → `formatDaemonInfo()`
   - `workers` → `client.send({ action: 'list-workers' })` → `formatWorkers()`
   - `logs` → tail last 30 lines of `getDaemonLogPath()`
3. `start` and `stop` inside REPL are still NOT auto-routed —
   in-process daemon lifecycle is a different concern. The handler
   returns a message telling the user to use `ovolv999 daemon start`
   / `ovolv999 daemon stop` from the CLI.

## Why ESM `await import` instead of `require`

The original `/daemon` stub used `require('../core/daemon.js')`.
That works in the compiled production output (resolved to
`dist/core/daemon.js`) but fails under vitest because TypeScript
runs through ESM, not CommonJS. R13 switches to `await import()`
which is path-correct in both contexts.

The runtime cost is one extra microtask per slash invocation —
negligible.

## Architecture

```
REPL → /daemon <sub>
       │
       └─ builtin.ts:daemon handler (async)
              │
              ├─ isDaemonRunning() → false: return "not running" message
              │
              └─ new DaemonClient(getDaemonSocketPath())
                     │
                     └─ Unix socket IPC
                            │
                            └─ Daemon (long-running)
                                  ├─ workers Map
                                  ├─ log file
                                  └─ cmd handlers
```

The slash command AND the CLI command both reach the same
`Daemon` process via the same `getDaemonSocketPath()` Unix socket.
The CLI path is for offline management (start/stop/attach); the
slash command is for in-session queries (status/workers/logs).

## Tests

`tests/r13-daemon-slash-command.test.ts` (6 tests):

1. Registers with status | workers | logs sub-commands
2. Returns a clean message when no daemon is running
3. **status** — actually queries the live daemon over the IPC socket
   (real socket, real Daemon, real `client.status()`)
4. **workers** — lists workers via the IPC socket (real `addWorker`
   + `client.send({ action: 'list-workers' })`)
5. **logs** — reads daemon log file content
6. **start/stop** inside REPL are deferred to the CLI

Plus all 4791 existing tests still pass.

## Verification recipe

```bash
# Confirm IPC pattern
grep -n "new DaemonClient" src/commands/builtin.ts

# Run the wiring tests
npx vitest run tests/r13-daemon-slash-command.test.ts

# Manual end-to-end
ovolv999 --daemon &  # start long-running
ovolv999 → /daemon status
ovolv999 → /daemon workers
ovolv999 → /daemon logs
```

## Future work (R14+)

- **Worker restart via REPL**: `client.send({ action: 'restart-worker' })`
  is implemented in the daemon but not yet exposed in the slash
  command. R14 candidate.
- **Attach to running session**: claude-code has `daemon attach
  <sessionId>` for tailing a running session's output. We have the
  infrastructure (`sessionStore`) but no `/daemon attach` slash.
- **Daemon-aware `/workers`**: the existing `/workers` slash command
  operates on tmux workers, not daemon workers. A unified view would
  be useful for `ovolv999` users running both modes.
