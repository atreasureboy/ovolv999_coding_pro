#!/usr/bin/env bash

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

info() { printf '[info] %s\n' "$*"; }
ok() { printf '[ok]   %s\n' "$*"; }
die() { printf '[error] %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "Node.js not found. Install Node >= 20."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node $NODE_MAJOR found; Node >= 20 required."
command -v npm >/dev/null 2>&1 || die "npm not found."

ok "Node $(node -v)"
info "Installing dependencies..."
[ -f package-lock.json ] || die "package-lock.json is required for reproducible setup."
npm ci --no-audit --no-fund

info "Building..."
npm run build

ENTRY="$PROJECT_DIR/dist/bin/ovogogogo.js"
[ -x "$ENTRY" ] || die "Build output missing or not executable: $ENTRY"
"$ENTRY" --version >/dev/null || die "Built CLI failed its version smoke test."

info "Creating global command..."
if npm link >/dev/null 2>&1 && command -v ovolv999 >/dev/null 2>&1 && ovolv999 --version >/dev/null 2>&1; then
  ok "ovolv999 is installed and verified."
else
  printf '[warn] npm link could not create a working global command.\n' >&2
  printf '       Run directly with: node %s\n' "$ENTRY" >&2
fi

printf '\nQuick start:\n'
printf '  ovolv999 init\n'
printf '  ovolv999\n'
printf '  ovolv999 "fix the failing tests"\n'
