# ACP WebSocket Transport

ovolv999's [Agent Client Protocol](https://github.com/agentclientprotocol/agent-client-protocol) implementation now supports two transports:

1. **stdio** (default) — line-delimited JSON-RPC 2.0 over stdin/stdout. Editor integration (Zed, Neovim).
2. **WebSocket** (new in v0.5.0) — same JSON-RPC 2.0 protocol over `ws://127.0.0.1:<port>/`. Browser dashboards, web IDEs, custom automation.

Both transports share the same `ACPTransport` interface — pick one at process start, the rest of the runtime is unchanged.

## Quick start (stdio)

This is the historical default. Just run `ovolv999` from your editor — no flags needed.

## Quick start (WebSocket)

```bash
ovolv999 --acp-ws 8765
```

Output:

```
[acp-ws] listening on ws://127.0.0.1:8765
[acp-ws] connect with ws://127.0.0.1:8765/?token=<generated-token>
```

Health check:

```bash
curl http://127.0.0.1:8765/health
# {"ok":true,"connections":0}
```

Connect with the generated URL. Set `OVOGO_ACP_WS_TOKEN` before startup to provide a stable token instead.

## Protocol

Both transports use the same wire format. Each frame is one JSON-RPC 2.0 message:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"my-editor","version":"1.0"}}}
```

Supported methods:

| Method | Description |
|---|---|
| `initialize` | Handshake; returns capabilities, protocol version, server info. |
| `message` | Submit user message; streams `response` notifications until `done: true`. |
| `interrupt` | Cancel the in-flight turn. |
| `file/read` | Read a file (path traversal-gated). |
| `file/write` | Write a file. |
| `cost` | Get session token usage and cost. |
| `shutdown` | Graceful shutdown. |

Server-emitted notifications (streamed during `message`):

| Notification | Description |
|---|---|
| `message/received` | The user's message was accepted. |
| `message/streaming` | Partial model output chunk. |
| `message/done` | Final response with `done: true`. |
| `tool/call` | Tool call starting. |
| `tool/result` | Tool result ready. |

## WebSocket frame transport (RFC 6455)

The WebSocket transport speaks **text frames only**. Each JSON-RPC message is a single text frame. Frames are split on `\n` for multi-message support.

Limitations (intentional, to keep zero-deps):

- **No binary frames** — JSON-RPC over text only.
- **No `permessage-deflate`** — clients requesting deflate get `400 Bad Request` with `Sec-WebSocket-Extensions: none supported`. Compression is a non-goal for the tiny JSON payloads we send.
- **No WSS** (TLS) — the server is plain HTTP/WS. Run it behind nginx/Caddy if you need TLS.
- **No sub-protocol negotiation** — clients should connect without `Sec-WebSocket-Protocol`.

## Security

The server binds to `127.0.0.1` by default — it does not listen on public interfaces. To bind externally:

```bash
OVOGO_ACP_WS_TOKEN="$(openssl rand -hex 32)" ovolv999 --acp-ws 8765 --acp-ws-bind 0.0.0.0
```

Every WebSocket upgrade requires the bearer token through `Authorization: Bearer <token>` or the `?token=<token>` query parameter. When binding externally, also use TLS, a firewall, or an SSH tunnel because query parameters and plain `ws://` traffic are not encrypted.

## Disconnecting

Close the WebSocket connection. The server cleans up its per-connection ACPServer instance within ~100ms.

## Examples

### Browser dashboard

```javascript
const ws = new WebSocket('ws://127.0.0.1:8765/?token=<TOKEN>')
ws.onopen = () => {
  ws.send(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { clientInfo: { name: 'dashboard', version: '1.0' } },
  }))
}
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  console.log('←', msg)
}
```

### Python automation

```python
import asyncio, json, websockets

async def main():
    async with websockets.connect('ws://127.0.0.1:8765/?token=<TOKEN>') as ws:
        await ws.send(json.dumps({
            'jsonrpc': '2.0', 'id': 1, 'method': 'message',
            'params': {'text': 'Refactor src/foo.ts to use async/await'},
        }))
        async for line in ws:
            print('←', line)
```

## Limitations

- One ACPServer instance per WebSocket connection. There is no shared session across connections (yet).
- The transport doesn't support server-to-client `request` (only `notification`). Reverse-direction requests must go through the `message` flow.
- `acp-ws` mode cannot be combined with `--pipe` or `--bg` (those have their own transport assumptions).
