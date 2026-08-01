# MCP OAuth (Authorization Code + PKCE)

ovolv999's MCP (Model Context Protocol) integration supports authenticated MCP servers via OAuth 2.1 Authorization Code + PKCE. Tokens persist at `~/.ovogo/mcp-tokens.json` (mode 0600) and refresh automatically.

## When you need this

Plain MCP servers over `stdio` or unauthenticated HTTP don't need this. You need OAuth when:

- The MCP server requires authentication (e.g. Atlassian Rovo, Notion, Linear — all gated MCP servers).
- Your organization runs a private MCP registry behind OAuth.
- You're testing a server that issues tokens via PKCE.

## Setup

1. Register your MCP client with the server's authorization server. Most providers issue a `client_id` (and optionally `client_secret` for confidential clients).
2. Add the server to your `~/.ovogo/settings.json` under `mcp.servers[]`:

```json
{
  "mcp": {
    "servers": [
      {
        "name": "notion",
        "type": "http",
        "url": "https://mcp.notion.example.com",
        "oauth": {
          "authorizationEndpoint": "https://auth.notion.com/authorize",
          "tokenEndpoint": "https://auth.notion.com/token",
          "clientId": "your-client-id",
          "clientSecret": "your-client-secret",
          "scope": "read:pages write:pages",
          "redirectUri": "http://127.0.0.1:8765/callback"
        }
      }
    ]
  }
}
```

3. On first connect, ovolv999 opens a browser window (or prints the URL if no display) to the authorization endpoint.
4. You approve, the server redirects to `redirectUri`, ovolv999 exchanges the code for tokens via PKCE, and persists the result.

## PKCE

We use **S256** code challenge method only. PKCE generation is per-request (`crypto.randomBytes(32)` for the verifier, SHA-256 for the challenge).

The `state` parameter is also randomly generated per request to prevent CSRF.

## Token refresh

Tokens are refreshed proactively — if the access token expires within the next 60 seconds, the next request triggers a `refresh_token` grant before proceeding. This avoids race conditions where a tool call would otherwise fail with a 401 mid-execution.

If the refresh fails (revoked token, scope changed), the next call throws `No valid token for MCP server <id>; authorization required`. The user must re-authorize via the same flow.

## Token storage

- Path: `~/.ovogo/mcp-tokens.json`
- Mode: `0600` (owner read/write only)
- Schema: `{ tokens: OAuthTokenSet[] }` — one entry per `serverId`

The file is **not** in git (add to `.gitignore` if you fork). It's regenerated on demand; deleting it forces re-authorization.

## CLI helpers

```bash
ovolv999 mcp list                    # Show configured servers + auth status
ovolv999 mcp auth <server-name>       # Re-trigger auth flow
ovolv999 mcp logout <server-name>     # Delete stored token
```

## Limitations

- **No Dynamic Client Registration** — you must manually register the client with the authorization server.
- **No JWT client auth** — only `client_secret_basic` and `client_secret_post` are supported.
- **No refresh-token rotation enforcement** — the auth server's policy is respected as-is.
- **Single redirect URI per process** — concurrent authorization flows from multiple servers serialize.
- **mTLS / private_key_jwt** — not implemented.
- **OAuth 2.1 only** — older OAuth 2.0 servers without PKCE support will fail.

## Troubleshooting

**"authorization_endpoint returns 400 invalid_request"** — your `redirectUri` doesn't match what the authorization server has registered. Add the exact URI to your OAuth client config.

**"refresh failed: 401 invalid_grant"** — your refresh token is revoked or the user changed scopes. Delete the token (`ovolv999 mcp logout`) and re-authorize.

**"No valid token for MCP server X"** — token not present and not refreshable. Run `ovolv999 mcp auth X` to authorize.

## Security

- We never log tokens in plaintext.
- The local token file is `0600` — verify with `ls -la ~/.ovogo/mcp-tokens.json`.
- Redirect URI defaults to `http://127.0.0.1:8765/callback` — keep it loopback to avoid token interception on shared networks.
- PKCE is mandatory — we don't downgrade to plain Authorization Code.
