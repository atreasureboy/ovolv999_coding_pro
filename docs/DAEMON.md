# Daemon Mode (Long-Running Supervisor)

ovolv999 daemon mode keeps the engine alive between user turns. Useful for:

- Long-running refactor sessions where you want to attach later
- Web dashboard integrations (the daemon can serve multiple clients)
- Headless automation (the daemon is the LLM agent "always-on")

## Quick start

### Start the daemon

```bash
ovolv999 --daemon
# Output:
#   [daemon] listening on http://127.0.0.1:52413
#   [daemon] socket: ~/.ovolv999/daemon.sock
#   [daemon] process id: 12345
```

The port is chosen dynamically (Ephemeral port). The socket path is fixed (`~/.ovolv999/daemon.sock`).

### Send a message to the daemon

```bash
ovolv999 --attach 550e8400-e29b-41d4-a716-446655440000 \
  --message "refactor src/foo.ts to use async/await"
```

The daemon creates a session (if it doesn't exist), runs the message, and returns the response.

### List sessions

```bash
ovolv999 --daemon-ps
# ID                                    STARTED    STATUS  GOAL
# 550e8400-e29b-41d4-a716-446655440000  2026-07-31  idle    refactor src/foo.ts
# ...
```

### Kill a session

```bash
ovolv999 --daemon-kill <session-id>
```

### Shutdown the daemon

```bash
ovolv999 --daemon-stop
```

## Architecture

```
┌──────────────────────────────────────────────┐
│  Daemon Process (single, long-running)        │
│  ┌─────────────────────────────────────────┐ │
│  │  SessionManager                          │ │
│  │  ├─ session 1: ExecutionEngine + state │ │
│  │  ├─ session 2: ExecutionEngine + state │ │
│  │  └─ ...                                 │ │
│  └─────────────────────────────────────────┘ │
│  HTTP listener on 127.0.0.1:<ephemeral>      │
│  Port exported as OVOGO_DAEMON_PORT           │
└──────────────────────────────────────────────┘
        ▲
        │ JSON-RPC 2.0 over HTTP
        │
   ┌────┴─────────────┐
   │  ovolv999 --attach │
   │  ovolv999 --ps     │
   └───────────────────┘
```

Each session is an independent ExecutionEngine instance with its own:
- Tools / modules
- Cost tracker
- Event log
- Permission mode
- Hook runner

Sessions persist across `ovolv999` invocations — the daemon outlives the CLI that started it.

## Wire protocol

All operations are HTTP POST to `http://127.0.0.1:<port>/` with JSON body:

```json
{"id": 1, "op": "list"}
{"id": 2, "op": "create", "goal": "...", "cwd": "..."}
{"id": 3, "op": "attach", "sessionId": "..."}
{"id": 4, "op": "message", "sessionId": "...", "text": "..."}
{"id": 5, "op": "detach", "sessionId": "..."}
{"id": 6, "op": "kill", "sessionId": "..."}
{"id": 7, "op": "shutdown"}
```

Response:
```json
{"id": <req-id>, "ok": true, "result": <data>}
{"id": <req-id>, "ok": false, "error": "..."}
```

## Persistence

Sessions are persisted to `~/.ovolv999/sessions/<id>.jsonl` (JSONL of every turn). When the daemon restarts, sessions can be restored by ID (planned 0.6.0; 0.5.x sessions are lost on daemon restart).

## Limitations

- Single daemon per machine (no multi-daemon coordination)
- No session migration between machines
- No built-in authentication (loopback only — bind to public IP is unsafe)
- Memory grows with session count (each session ~50-100 MB)

## Security

The daemon binds to `127.0.0.1` only — there's no authentication because the OS already authenticates loopback users. **Do not** bind to `0.0.0.0` without first adding an auth layer (planned 0.6.0).

If you need to expose the daemon to other machines, run it behind a TLS reverse proxy (nginx, caddy) that enforces auth.

## Files

- `src/core/daemon/daemonServer.ts` — HTTP server + JSON-RPC dispatch
- `src/core/daemon/daemonClient.ts` — typed client for `--attach`
- `src/core/daemon/sessionManager.ts` (planned 0.6.0) — session lifecycle
- `tests/core/daemon.test.ts` — round-trip tests

## Comparison to `--bg` / BackgroundTaskManager

| Feature | `--bg` | Daemon |
|---|---|---|
| Process lifetime | Same as engine | Survives CLI exit |
| Multi-session | No (1 engine per CLI) | Yes (N sessions per daemon) |
| Attach from another process | No | Yes (`--attach`) |
| Session persistence | None (lost on exit) | JSONL (0.6.0) |
| Memory model | Per CLI invocation | Per session, daemon-resident |
| IPC | None | HTTP JSON-RPC over loopback |
| Use case | Single-shot background tasks | Long-running interactive work + automation |
