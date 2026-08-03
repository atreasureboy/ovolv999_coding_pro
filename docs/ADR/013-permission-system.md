# ADR-013: Permission system (R9 wiring + 7-mode contract)

## Context

Closer evaluation of `permissionRules.ts` (after R8 SDK work) revealed
two facts:

1. **The glob engine was dead code.** `src/core/permissionRules.ts`
   had 267 lines of priority-sorted glob rules, a session-scoped
   `ApprovalCache`, and a default rule set with deny rules like
   `rm -rf **`, `sudo **`, `**/.env*`. But the only caller was
   `src/core/settingsSync.ts` for export/import — every tool execution
   ignored it. The deny rules were "wasted ink" (CLAUDE.md P2 backlog).

2. **7-mode type was defined but only 2-3 modes had real behavior.** The
   `PermissionMode` union has 7 variants (`default / acceptEdits / plan /
   auto / bypassPermissions / dontAsk / bubble`), but `dontAsk` and
   `bubble` were partially wired (label/helper only) and `acceptEdits`
   collapsed to `default` semantics in `getModeBehavior`.

R9 closes both gaps:
- R9.2: wire `permissionRules.ts` into the tool executor as a 4th
  permission layer (after policy, mode gate, before permissionManager).
- R9.3: wire `dontAsk` to actually suppress prompts and document the
  full 7-mode contract.

## Architecture: 5-layer permission flow

The tool execution path now has 5 layers stacked from broadest to
narrowest:

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 1: toolPolicy.checkExecutionAllowed                    │
│   - plan mode enforcement                                   │
│   - agent allowlist (capability-first)                      │
│   - excludedTools (built-in or user-set)                    │
└─────────────────────────────────────────────────────────────┘
                              │ pass
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ Layer 2: gateByPermissionMode                                │
│   - coarse mode gate (default / acceptEdits / plan / etc.)  │
│   - bypassPermissions + dontAsk + bubble → 'allow'           │
│   - other modes → 'check' (proceed to layer 3)              │
│ Note: even on 'allow' paths, Layer 3 still runs (R20 fix).  │
│ Deny-wins: a glob rule denying the action short-circuits     │
│ the entire flow. Mode cannot bypass a deny.                  │
└─────────────────────────────────────────────────────────────┘
                              │ pass
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ Layer 3: evaluateDefaultGlobRule (R9.2 wiring)               │
│   - priority-sorted glob rules                              │
│   - DENY WINS OVER MODE (defense in depth)                  │
│   - allow / ask fall through to layer 4                     │
│   - sessionApprovalCache short-circuits asks                │
└─────────────────────────────────────────────────────────────┘
                              │ pass
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ Layer 4: permissionManager.check                            │
│   - user-defined rules from settings file                   │
│   - mode -> behavior (getModeBehavior)                      │
│   - dangerous classification (Bash risk classifier)         │
└─────────────────────────────────────────────────────────────┘
                              │ ask
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ Layer 5: requestPermission (UI prompt)                       │
│   - dontAsk mode: auto-approve without dialog (R9.3)         │
│   - other modes: show PermissionDialog                      │
│   - "always allow" → adds rule to layer 4                   │
└─────────────────────────────────────────────────────────────┘
                              │ approved
                              ▼
                          Execute tool
```

## Why deny wins (deny > mode > allow)

This is non-obvious. The intuition is "if the user said bypassPermissions,
allow everything". But that creates a one-line hostile config:
`{ "permissionMode": "bypassPermissions" }` in `.ovolv999.json` and the
model rm -rf's the user's home directory.

The deny-first principle collapses two threats:

- **Misconfigured mode**: a user sets `bypassPermissions` for a toy
  project, then reuses the same config in a critical one — they didn't
  change the mode, but the explicit glob rule `deny-rm-rf` still fires.
- **Model overconfidence**: a model trained on permissive defaults
  might try `sudo apt-get update` even in `bypassPermissions`. The
  deny rule `deny-sudo` blocks it regardless of mode.

The user can override `rm -rf` denial by REPL command — but they have
to look at the explicit deny rule and decide to override it. Friction
is the point.

## 7-mode contract (after R9.3)

| Mode | Coarse gate (L2) | Glob engine (L3) | permissionManager (L4) | UI prompt (L5) |
|---|---|---|---|---|
| `default` | `'check'` | glob rules (always) | risk-classified ask | dialog |
| `acceptEdits` | `'allow'` for edit tools, `'check'` otherwise | glob rules (always) | risk-classified ask | dialog |
| `plan` | `'check'` (plan-mode policy in L1) | glob rules (always) | read-only allowlist | dialog |
| `auto` | `'check'` | glob rules (always) | dangerous → ask | dialog |
| `bypassPermissions` | `'allow'` | glob rules (always) | skip | dialog (audit) |
| `dontAsk` | `'allow'` | glob rules (always) | skip | **auto-approve** (R9.3) |
| `bubble` | `'allow'` | glob rules (always) | skip | dialog |

The `bubble` row shows the cross-layer feature: the bash tool (a
specific tool, not the permission layer) checks `permissionMode === 'bubble'`
and wraps the command with `sandboxWrap` (bwrap / OS sandbox-exec).
This is the only mode that physically changes the command being
executed, not just the gating.

## Why delta from claude-code is small

claude-code has the same 5-layer architecture (their `bubble`
permission mode is mechanically similar; their `permissionManager` is
the same as ours; their `preToolUse` hook is layer 4.5). The
delta is:

- We have **one** glob engine (claude-code has it inline with
  permissionManager). We made it a separate layer so the deny-first
  principle is structurally enforced, not buried in mode-switch
  logic.
- We have **session-scoped approval cache** — once you approve
  `npm test`, future calls don't ask. This is a user-experience
  improvement claude-code doesn't have.
- We have **deny-first** as a structural invariant. claude-code's
  rules evaluate in order, so a deny rule placed after an allow
  rule with the same priority is silently ignored.

## Tests

New file: `tests/r9-glob-permission-wiring.test.ts` (8 tests):

- denies BASH rm -rf regardless of mode (defense-in-depth)
- denies BASH sudo regardless of mode
- denies WRITE to .env files
- allows BASH safe commands even with default mode
- allows READ on any path by default
- session-approval cache skips subsequent asks
- Bash tool wraps command with sandbox when permissionMode === bubble
- dontAsk mode: glob engine deny still wins (deny is non-negotiable)

Plus all 89 existing permission tests still pass.

## Future work (out of scope for R9)

- **User-rules UI**: claude-code has a `/permissions` slash command
  that lists rules. We have `formatPermissionSummary` but no CLI
  command. R10 candidate.
- **Glob rule specificity**: `rm -rf **` matches `rm -rf /tmp/x` but
  not `rm -rf "$HOME"` (quoted). Claude-code's mini-language handles
  shell quoting. R11 candidate.
- **Permission rules in settings.json**: the `permissionRules` field
  is exported by settingsSync but not imported at engine boot. R12
  candidate.

## Outcome

R9 closed the gap between "permission types defined" and "permission
types enforced". The 7-mode contract is now an actual contract with
real behavior at each layer, not just labels. The 5-layer
defense-in-depth means even a hostile mode config cannot bypass the
deny rules.
