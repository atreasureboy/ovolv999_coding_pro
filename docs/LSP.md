# LSP Integration

ovolv999 can talk to any LSP (Language Server Protocol) server. The LLM uses 4 LSP methods — `definition`, `references`, `hover`, `documentSymbol` — to navigate code without reading every file.

## Configure LSP servers

`~/.ovogo/settings.json`:

```json
{
  "lsp": {
    "servers": {
      "typescript": {
        "command": "typescript-language-server",
        "args": ["--stdio"],
        "fileExtensions": [".ts", ".tsx"]
      },
      "python": {
        "command": "pyright-langserver",
        "args": ["--stdio"],
        "fileExtensions": [".py"]
      },
      "gopls": {
        "command": "gopls",
        "args": [],
        "fileExtensions": [".go"]
      }
    }
  }
}
```

The first matching server (by file extension) is used for each file.

## Use from the LLM

When the model wants to know "where is `connectToDatabase` defined?", it calls:

```json
{
  "tool": "lsp",
  "input": {
    "method": "definition",
    "uri": "file:///home/user/project/src/auth.ts",
    "line": 12,
    "character": 4
  }
}
```

The tool returns:

```json
{
  "locations": [
    {
      "uri": "file:///home/user/project/src/db.ts",
      "range": {"start": {"line": 5, "character": 0}, "end": {"line": 5, "character": 24}}
    }
  ]
}
```

The LLM then knows `connectToDatabase` is defined in `db.ts:5` and can `Read` that file directly.

## The 4 supported methods

| Method | Use case |
|---|---|
| `definition` | "Where is this symbol defined?" |
| `references` | "Where is this symbol used?" |
| `hover` | "What's the type signature + docs for this?" |
| `documentSymbol` | "List all top-level symbols in this file" |

That's the minimum useful surface. Full LSP has 100+ methods — we deliberately stop at 4 to keep the integration simple and well-tested.

## Architecture

`src/core/lsp/client.ts`:

1. **Spawn** the LSP server process (`command [args]`)
2. **stdio framing**: `Content-Length: <n>\r\n\r\n<body>` per LSP spec
3. **initialize** handshake with rootUri + minimal capabilities
4. **initialized** notification
5. **JSON-RPC 2.0** requests for `textDocument/definition` etc.
6. **shutdown** + **exit** on close

The client is intentionally minimal:

- Synchronous request/response only (no async streaming)
- No workspace/didChange notifications (we don't edit through the LLM)
- No progress reporting
- No cancellation support

This keeps the integration <300 lines and easy to test.

## Use cases

### Code navigation
The LLM needs to find a function definition before editing it:
```
User: "fix the bug in connectToDatabase"
LLM: lsp(definition, src/auth.ts:12) → src/db.ts:5
LLM: Read(src/db.ts:5-30)
LLM: lsp(hover, src/db.ts:5) → "function connectToDatabase(url: string): Promise<Connection>"
LLM: Edit(src/db.ts, ...)
```

### Symbol search
```
User: "list all exported functions in src/api/"
LLM: lsp(documentSymbol, src/api/users.ts) → [User, createUser, deleteUser, ...]
```

### Refactor safety
Before deleting a function:
```
LLM: lsp(references, src/auth.ts:12) → 47 locations
LLM: ...
LLM: confirm with user before proceeding
```

## Performance

- Cold start: ~500ms (LSP server initialization)
- Warm requests: 10-50ms per call
- Memory: 50-150 MB per LSP server (depends on language)

For large projects, start LSP servers once per session — they're heavyweight.

## Limitations

- We don't push file edits back to the LSP server (`workspace/didChangeWatchedFiles` etc.) — the LLM edits via Edit/Write tools, not through LSP
- No semantic tokens / completions / code actions — just the 4 navigation methods
- No multi-root workspaces
- No pull diagnostics (the model has its own WorkingState tracking via Bash/Read)

## Tests

`tests/core/lsp.test.ts` covers:
- SymbolKind enum completeness
- URI conversion (Unix / Windows paths)
- Client state machine (open / closed)

The integration test (real LSP server round-trip) requires `typescript-language-server` to be installed — run separately.

## Files

- `src/core/lsp/client.ts` — JSON-RPC 2.0 stdio client
- `src/core/lsp/protocol.ts` — minimal LSP type definitions
- `tests/core/lsp.test.ts` — unit tests
