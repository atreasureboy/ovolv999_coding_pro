# Security Policy

## Supported version

Security fixes are applied to the latest released version.

## Reporting a vulnerability

Do not open a public issue for an unpatched vulnerability. Use GitHub's private vulnerability reporting for this repository and include the affected version, reproduction steps, impact, and any proposed mitigation.

We will acknowledge a complete report within seven days, keep the reporter informed while it is investigated, and coordinate disclosure after a fix is available.

## Runtime trust boundary

ovolv999 is a coding agent and may execute tools in the selected workspace. Review permission and sandbox settings before using it against untrusted repositories. Keep API credentials outside repositories and do not commit `.env` files or provider tokens.

Project hooks, plugins, permission overrides, MCP servers, provider overrides, and model routing profiles are disabled by default because they can change permissions, start processes, redirect providers, or execute with host privileges. Safe project metadata and runtime settings remain available. Set `OVOGO_TRUST_PROJECT_CODE=1` only after reviewing the repository's `.ovogo/settings.json`, `.ovolv999.json(c)`, and `.ovolv999/plugins/` contents.
