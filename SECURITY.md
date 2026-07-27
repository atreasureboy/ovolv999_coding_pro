# Security Policy

## Supported version

Security fixes are applied to the latest released `0.3.x` version.

## Reporting a vulnerability

Do not open a public issue for an unpatched vulnerability. Use GitHub's private vulnerability reporting for this repository and include the affected version, reproduction steps, impact, and any proposed mitigation.

We will acknowledge a complete report within seven days, keep the reporter informed while it is investigated, and coordinate disclosure after a fix is available.

## Runtime trust boundary

ovolv999 is a coding agent and may execute tools in the selected workspace. Review permission and sandbox settings before using it against untrusted repositories. Keep API credentials outside repositories and do not commit `.env` files or provider tokens.

