# Permission Modes

ovolv999 supports 7 permission modes (matching Claude Code's full set). Switch with `/mode <name>` or `--permission-mode <name>`.

## The 7 modes

| Mode | Symbol | Description |
|---|---|---|
| `default` | | Ask for dangerous commands, allow safe ones (Claude Code default) |
| `acceptEdits` | `>>` | Auto-approve file edits, still gate shell commands |
| `plan` | `\|\|` | Read-only analysis (no writes/edits/bash) |
| `auto` | `>>>` | Auto-approve everything except dangerous commands |
| `bypassPermissions` | `>>>>` | Approve everything (use with caution) |
| `dontAsk` | `?!` | No prompts: trust the model + hooks only |
| `bubble` | `[][]` | Shell commands run in OS-level sandbox |

## Switching modes

### In-session: `/mode <name>`

```
> /mode bubble
→ permission mode: bubble (Sandbox) — shell commands run in OS-level sandbox

> /mode auto
→ permission mode: auto — Auto-approve everything except dangerous commands
```

### At startup: `--permission-mode <name>`

```bash
ovolv999 --permission-mode acceptEdits
ovolv999 --permission-mode bubble  # shell sandbox (macOS sandbox-exec / Linux Landlock)
```

### Settings file

`~/.ovogo/settings.json` (persists across sessions):

```json
{
  "permissionMode": "acceptEdits"
}
```

## Mode semantics in detail

### `default` — Standard ask mode

- Read tools (`Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch`): always allowed
- Edit/Write tools (`Write`, `Edit`, `NotebookEdit`): allowed for safe paths, ask for risky ones
- Bash: classify command risk; dangerous → ask, safe → allow
- MCP tools: same as their base risk level

### `acceptEdits` — File edits without prompts

- Same as `default` for Bash / MCP / Read tools
- Edit/Write/NotebookEdit: ALWAYS allowed (no ask)
- Useful for refactor-heavy sessions where you've already triaged what the model is doing

### `plan` — Read-only mode

- Read tools only (per existing `ToolPolicy.getExposedDefinitions`)
- Write/Edit/Bash/MCP tools: hidden from the LLM (not just blocked at execution)
- EnterPlanMode tool is exposed to leave plan mode
- Session log shows the model is in plan mode

### `auto` — Default with reduced prompts

- Same as `default` but: model has more autonomy for medium-risk ops
- Dangerous operations still ask
- Useful when you've reviewed the project context and trust the model

### `bypassPermissions` — No prompts, all allowed

- Every tool runs without asking
- Hooks still fire (your PreToolUse hook can deny / modify)
- **Use only when**: you've reviewed the request manually and want to let the model run uninterrupted
- For untrusted code or unknown tasks: stay on `default` or `auto`

### `dontAsk` — Trust the model + hooks

- No permission prompts are shown
- Hooks are the only gate (your PreToolUse hook is the security boundary)
- Tools run on the model's judgment alone
- Useful for headless / CI / automation contexts

### `bubble` — OS-level sandbox

- All Bash commands run inside an OS sandbox:
  - macOS: `sandbox-exec` with deny-by-default SBPL profile (no network, restricted FS)
  - Linux: Landlock (kernel-native) via helper; falls back to `bwrap`
  - Windows / unsupported: warns + falls back to no-op
- File writes outside the workdir are blocked at the kernel layer
- Network access is denied (the model cannot exfiltrate)
- See `docs/SANDBOX.md` for the full profile

## Cycling mode

In the REPL, press **Shift+Tab** to cycle through modes in this order:

```
default → acceptEdits → plan → auto → bypassPermissions → dontAsk → bubble → default
```

The current mode is shown in the status line at the bottom of the REPL.

## Hook integration

Permission modes interact with hooks as follows:

| Mode | Hook effect |
|---|---|
| `default` | Hook fires + permission prompt fires |
| `acceptEdits` | Edit hooks fire; Edit prompt bypassed |
| `plan` | All tool calls blocked except read tools |
| `auto` | Hook fires; prompt only on dangerous commands |
| `bypassPermissions` | Hook still fires (your last gate) |
| `dontAsk` | Hook is the only gate (no prompts) |
| `bubble` | Bash commands sandboxed at OS level; hooks fire as usual |

`PreToolUse` hooks that return `decision: "deny"` are **always honored** regardless of mode — your hooks are the absolute security boundary.

## Recommendations by use case

| Scenario | Recommended mode |
|---|---|
| First run on a new codebase | `default` |
| Refactoring session you've reviewed | `acceptEdits` |
| Architecture review | `plan` |
| Trusted dev environment | `auto` |
| CI / automation | `dontAsk` |
| Production incident response | `bypassPermissions` |
| Untrusted codebase / exploring | `bubble` |

## Tool invocation patterns

Permission mode interacts with these existing patterns:

- **Hooks** (Phase 2): your `PreToolUse` hooks can deny / modify input regardless of mode
- **Sandbox** (Round 3): `bubble` mode adds OS-level isolation on top of hooks
- **Permission rules** (`permissionRules.ts`): rule-based allow/deny/ask per (tool, content)
- **Tool execution timeout**: independent of mode

Permission modes are the **coarse** knob; hooks + sandbox + rules are the **fine** knob.
