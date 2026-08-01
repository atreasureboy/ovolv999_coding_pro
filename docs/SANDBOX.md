# Shell Sandbox (Bubble Mode)

ovolv999 supports OS-level shell sandboxing in **`bubble` permission mode** — Bash tool calls are wrapped in a sandbox so the model cannot escape the project directory or make network requests.

## Backends

| OS | Backend | Mechanism |
|---|---|---|
| macOS 10.15+ | `sandbox-exec` | Built-in kernel sandbox, deny-by-default SBPL profile |
| Linux 5.13+ | `ovolv999-sandbox-helper` | Landlock (kernel-native, unprivileged) |
| Linux (fallback) | `bwrap` | Bubblewrap (if installed) |
| Windows / other | none | Warning + best-effort isolation (no kernel sandbox available) |

## Enabling bubble mode

```bash
ovolv999 --permission-mode bubble
```

Or in-session:

```
> /mode bubble
→ permission mode: bubble (Sandbox) — shell commands run in OS-level sandbox
```

## What the sandbox restricts

The default SBPL profile (macOS):

```
(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow sysctl-read)
(allow file-read* file-write*
  (subpath "/tmp")
  (subpath "/private/tmp")
  (subpath "<WORKDIR>")
  (literal "/dev/null")
  (literal "/dev/zero")
  (literal "/dev/tty")
  (literal "/dev/urandom"))
(allow system-socket)
(deny network-outbound)
```

The Linux Landlock profile:

```
fs-read:    <WORKDIR>, /usr, /lib, /etc, /tmp
fs-write:   <WORKDIR>, /tmp
no-new-privs: 1
no-network:    1
no-mount:      1
```

**Restricted**:
- File reads outside the workdir (except `/tmp`, `/dev/*`)
- File writes outside the workdir (except `/tmp`)
- Network connections (outbound `socket()` calls denied)

**Allowed**:
- Process exec + fork (so shells can spawn child processes)
- Read access to `/usr`, `/lib`, `/etc` for system tool discovery
- Read access to `/dev/null`, `/dev/zero`, `/dev/tty`, `/dev/urandom`
- `/tmp` for scratch files

## Implementation

`src/core/shellSandbox.ts` wraps `child_process.spawn` for the Bash tool:

1. **Detect backend** by OS at engine startup
2. **macOS path**: prepend `/usr/bin/sandbox-exec -p <profile>` to argv
3. **Linux path**: invoke `ovolv999-sandbox-helper` Landlock wrapper (or `bwrap` fallback)
4. **Unknown OS**: log a warning + run unsandboxed (graceful degradation)

The wrapper is invisible to the Bash tool — it just sees `command` and `args`, gets a sandboxed child process back.

## Helper binary

For Linux Landlock, ovolv999 ships with a small `ovolv999-sandbox-helper` (source in `scripts/sandbox-helper.c`). It's:

- Pure C, ~150 lines
- Unprivileged (no setuid needed)
- Compiled at install time via `install.sh`
- Falls back to `bwrap` if Landlock isn't supported (kernel < 5.13)

If the helper isn't installed, Linux users see:

```
[sandbox] ovolv999-sandbox-helper not found in PATH — running unsandboxed
[sandbox] install hint: ./install.sh builds it from scripts/sandbox-helper.c
```

## Testing the sandbox

After enabling bubble mode, try:

```bash
ls /etc/passwd          # should succeed (read /etc allowed)
cat /etc/shadow         # should succeed (read allowed) but content is project-readable
curl https://example.com # should fail (no network)
rm -rf /                # should fail (write outside workdir)
```

If the sandbox is correctly enforced, only commands within the workdir succeed and no network connection is possible.

## Compatibility with hooks

Bubble mode is **layered** on top of hooks:

```
model request → permission mode check → PreToolUse hooks → sandbox (if bubble) → execute
```

- PreToolUse hooks fire BEFORE the sandbox (can deny / modify input)
- PostToolUse hooks fire AFTER execution
- A PreToolUse deny short-circuits the sandbox entirely (the command never runs)
- Sandbox failures bubble up as `ToolResult { isError: true }`

## Limitations

- The sandbox does NOT enforce memory or CPU limits — use cgroups for that
- Network is binary (on/off), not per-domain
- macOS sandbox-exec is process-scoped, not container-scoped
- Windows fallback is non-existent (warns but runs unsandboxed)
- The sandbox does not protect against the LLM itself exfiltrating data via tool output

## Reporting

`/why` shows the active sandbox backend + a brief profile summary:

```
> /why
permission mode: bubble
sandbox backend: sandbox-exec (macOS 14.5)
profile: deny default + allow file-{read,write} in <workdir>/tmp; deny network-outbound
```

## Exit codes

The wrapper preserves the child's exit code. If the sandbox denies a syscall, the child typically exits with `EPERM` (errno 1) or `EACCES` (errno 13) — surfaced to the LLM as `ToolResult { isError: true, content: '<command> failed: Operation not permitted' }`.
