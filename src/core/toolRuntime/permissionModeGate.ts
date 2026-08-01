/**
 * Permission mode gating — coarse, mode-level decision BEFORE
 * permissionManager. Returns 'allow' / 'deny' / 'check'.
 *
 * Mode behaviors (Round 5 real integration):
 *   default           → check  (current behavior)
 *   acceptEdits       → Edit/Write/NotebookEdit: allow; other: check
 *   plan              → all writes denied (handled by toolPolicy; here: check)
 *   auto              → check (with risk classifier)
 *   bypassPermissions → allow all
 *   dontAsk           → allow all (no prompts)
 *   bubble            → check + Bash tool wraps sandbox (see tools/bash.ts)
 */

export type ModeGateResult = 'allow' | 'deny' | 'check'

const EDIT_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit'])

export function gateByPermissionMode(
  mode: 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions' | 'dontAsk' | 'bubble',
  toolName: string,
): ModeGateResult {
  switch (mode) {
    case 'bypassPermissions':
    case 'dontAsk':
      return 'allow'
    case 'acceptEdits':
      return EDIT_TOOLS.has(toolName) ? 'allow' : 'check'
    case 'default':
    case 'plan':
    case 'auto':
    case 'bubble':
      return 'check'
  }
}
