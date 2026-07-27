#!/usr/bin/env bash
# ovolv999 快速启动 (macOS / Linux)
# 用法: ./start.sh 或 ./start.sh "your task"

set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

command -v node >/dev/null 2>&1 || {
    echo "[error] Node.js not found (Node >= 20 required)" >&2
    exit 1
}

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
    echo "[error] Node $NODE_MAJOR found; Node >= 20 required" >&2
    exit 1
fi

if [ ! -d node_modules ]; then
    echo "[*] Installing dependencies..."
    if [ -f package-lock.json ]; then
        npm ci --no-audit --no-fund
    else
        npm install --no-audit --no-fund
    fi
fi

ENTRY="dist/bin/ovogogogo.js"
if [ ! -f "$ENTRY" ] || [ ! -f dist/package.json ] ||
   find bin src -type f -newer "$ENTRY" -print -quit | grep -q . ||
   [ package.json -nt "$ENTRY" ] || [ tsconfig.json -nt "$ENTRY" ]; then
    echo "[*] Building..."
    npm run build
fi

exec node "$ENTRY" "$@"
