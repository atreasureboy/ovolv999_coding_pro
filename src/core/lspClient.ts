/**
 * Compatibility shim — re-exports the unified LSP client.
 *
 * The single source of truth is `src/core/lsp/client.ts` (R8: uses
 * `vscode-jsonrpc`). This file is kept so existing imports
 * (`require('../core/lspClient.js')` in builtin.ts, `from '../core/lspClient.js'`
 * in tests) continue to work — the surface is identical.
 *
 * Long-term: callers should migrate to `src/core/lsp/client.js` directly.
 * The `lspTool.ts` and new code already do.
 */

export * from './lsp/client.js'
