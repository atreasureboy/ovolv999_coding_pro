# ADR-014: Permission rules user configuration (R10)

## Context

R9 (ADR-013) closed the gap between "permission types defined" and
"permission types enforced" — the 7-mode permission system has real
behavior at every layer (toolPolicy → modeGate → globEngine →
permissionManager → UI prompt). But R9 also identified three follow-up
items that were deferred:

- **User-rule load from settings.json** at engine boot
- **`/permissions` slash command** to manage rules at runtime
- **Shell quoting** in glob patterns (handle `rm -rf "$HOME"`)

R10 picks up the first two. R10.1 confirmed the first was already
implemented (engineAssembly.ts:184-188 loads `settings.permissions.rules`
into the PermissionManager) but untested. R10.2 added the test. R10.3
discovered that `/permissions` was already registered with a richer
command set than originally drafted — the deliverable became "test what
exists" rather than "add new".

## Where rules come from

```
                                   ┌─────────────────┐
                                   │   ~/.ovogo/     │
                                   │ settings.json   │  global rules
                                   └────────┬────────┘
                                            │
                                            ▼
                              ┌──────────────────────────┐
                              │  settings.ts:tryParse +  │
                              │  normalizePermissionRule │
                              └────────┬─────────────────┘
                                       │
                                       ▼
                              ┌──────────────────────────┐
                              │  OvogoSettings.          │
                              │  permissions.rules[]     │
                              │  (project overrides      │
                              │   global)                │
                              └────────┬─────────────────┘
                                       │
                                       ▼
                       ┌───────────────────────────────────┐
                       │  engineAssembly.ts:184-188        │
                       │  for (rule of settings.perms)    │
                       │    permissionManager.addRule()    │
                       └────────┬──────────────────────────┘
                                │
                                ▼
                       ┌───────────────────────────────────┐
                       │  PermissionManager.rules         │
                       │  (Layer 4 of the 5-layer flow)   │
                       └───────────────────────────────────┘
```

Note: project-settings rules **append** after global rules. The first
match wins in `checkRules()`. If a rule in either scope fires, the
mode is bypassed for that call.

## /permissions command surface

The existing `/permissions` command (long predating R10; R10.3 just
verified it) supports:

| Sub-command | Effect |
|---|---|
| `/permissions` (no args) | Show mode + rules |
| `/permissions rules` | Show rules only |
| `/permissions mode [name]` | Show / set mode (5-mode legacy list) |
| `/permissions cycle` | Cycle to next mode (Shift+Tab equivalent) |
| `/permissions allow <Tool> <pattern>` | Add allow rule |
| `/permissions deny <Tool> <pattern>` | Add deny rule |
| `/permissions remove <index>` | Remove rule by index |
| `/permissions clear` | Remove all rules |

`/perms` is the alias.

The mode list in the existing command is the legacy 5-mode set
(`default / acceptEdits / plan / auto / bypassPermissions`). The
type system supports 7, but the command surface only accepts 5. Adding
`dontAsk` and `bubble` to the command's mode-allowlist is a small bug
fix; it would let users click through to `dontAsk` mode without
editing a settings file.

## Differences from claude-code

claude-code's `/permissions` has these sub-commands we don't:
- `add-users` — multi-user rule scenarios
- `set mode` — explicitly set mode (we have `mode`)
- `reset` — restore factory rules (we have `clear`, which removes all)
- `show` — alias for the no-arg form

The pattern is the same: list / add / remove / clear / mode-*.
Differences are mostly cosmetic.

## Why this was worth a round

The original CLAUDE.md P2 backlog listed:
> `permissionRules.ts` glob engine (未接线,内置 deny 规则浪费)

R9 wired the engine. R10 wired the **user-facing** side: the rules
that flow from settings.json into the engine, and the slash command
that lets users configure rules at runtime. Prior to R10, a user
could run `cat logs.json | grep error` and the deny rule for `rm -rf`
would fire — but they had no way to add their own allow rules
without editing a JSON file. Now they can do `/permissions allow Bash "pytest *"`
and the rule is added, evaluated, and persisted.

## Tests

- `tests/r10-permission-rules-from-settings.test.ts` (4 tests):
  - User rule `Bash:ls * → allow` overrides default mode
  - User rule `Bash:rm -rf * → deny` beats default mode
  - User rule `Bash:npm test → ask` overrides default allow
  - settings.json permissions.rules are actually parsed (no schema gap)

- `tests/r10-permissions-slash-command.test.ts` (11 tests):
  - Exists and lists mode + rules
  - allow / deny / remove / clear / mode / cycle all mutate the manager
  - Invalid mode + invalid index are clean errors
  - Persists via persistPermissions after every mutation
  - In-memory rules survive across the same engine instance

Plus all 4761+ existing tests still pass.

## Verification recipe

```bash
# Confirm rules from settings.json are loaded
grep -n "settings.permissions?.rules" src/cli/engineAssembly.ts

# Confirm /permissions is registered
grep -n "name: 'permissions'" src/commands/builtin.ts

# Confirm /permissions handler mutates the real manager
grep -n "mgr.addRule\|mgr.removeRule\|mgr.setMode" src/commands/builtin.ts

# Run the wiring tests
npx vitest run tests/r10-permission-rules-from-settings.test.ts \
  tests/r10-permissions-slash-command.test.ts
```

## Future work (R11+)

- **Shell quoting in glob patterns**: `rm -rf *` matches
  `rm -rf "$HOME"` literally (quotes intact). Use a shell-aware
  tokenizer before glob match.
- **`/permissions mode dontAsk` / `bubble`**: extend the mode
  allowlist in the existing command to accept the 7-mode union.
- **`permissions.ui` system-reminder**: when rules change, emit a
  control message so the LLM knows the permission set changed.
