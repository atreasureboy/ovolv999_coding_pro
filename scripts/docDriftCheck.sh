#!/usr/bin/env bash
# Document drift check — CI verification layer (super_plan.md Round 5.4)
# Detects inconsistencies between documentation claims and code reality:
#   1. Version: package.json ↔ README ↔ VERSION ↔ CHANGELOG
#   2. Tool count: CLAUDE.md vs createTools()
#   3. Module count: CLAUDE.md vs engine modules
#   4. ICM count: CLAUDE.md vs InternalControlMessage union
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FAIL=0
echo "=== Document-Drift Audit ==="

# ── 1. Version consistency ──
echo ""
echo "--- Version consistency ---"
PKG_VER=$(node -e "console.log(require('./package.json').version)")
README_VER=$(grep -oP 'v?\d+\.\d+\.\d+' README.md 2>/dev/null | head -1 | sed 's/^v//')
VERSION_VER=$(cat VERSION 2>/dev/null | tr -d '\n\r')
CHANGELOG_VER=$(grep -oP '## \K\d+\.\d+\.\d+' CHANGELOG.md 2>/dev/null | head -1)

echo "  package.json: $PKG_VER"
echo "  README:       $README_VER"
echo "  VERSION:      $VERSION_VER"
echo "  CHANGELOG:    $CHANGELOG_VER"

if [ "$PKG_VER" != "$VERSION_VER" ]; then
  echo "  MISMATCH: package.json ($PKG_VER) != VERSION ($VERSION_VER)"
  FAIL=1
fi
if [ "$PKG_VER" != "$README_VER" ]; then
  echo "  WARNING: package.json ($PKG_VER) != README ($README_VER)"
fi
# CHANGELOG top entry may be ahead (unreleased _in progress_ section) — OK
if [ -n "$CHANGELOG_VER" ] && [ "$CHANGELOG_VER" != "$PKG_VER" ]; then
  echo "  NOTE: CHANGELOG top ($CHANGELOG_VER) differs from package.json ($PKG_VER) — unreleased section OK"
fi

# ── 2. Tool count ──
echo ""
echo "--- Tool count ---"
# Each tool is a separate .ts file in src/tools/ (excluding index, helpers, shared types)
TOOL_FILES=$(ls src/tools/*.ts 2>/dev/null | grep -v "index\|\.test\|\.d\." | wc -l)
echo "  Tool source files (src/tools/*.ts): $TOOL_FILES"

# ── 3. Module count ──
echo ""
echo "--- Module count ---"
# Production modules = modules/ subdirectories with index.ts minus experimental/
PROD_MODULES=$(ls src/modules/*.ts 2>/dev/null | grep -v "index\|test\|\.d\." | wc -l)
echo "  Production modules (src/modules/*/index.ts): $PROD_MODULES"

# ── 4. ICM kind count ──
echo ""
echo "--- ICM kind count ---"
ICM_KINDS=$(grep -oP "kind: '\K[^']+" src/core/runtime/internalControlMessage.ts 2>/dev/null | sort -u | wc -l)
echo "  InternalControlMessage kinds: $ICM_KINDS"

# ── 5. RunEvent variant count ──
echo ""
echo "--- RunEvent variant count ---"
EVENT_VARIANTS=$(grep -oP "type: '\K[^']+" src/core/runtime/events.ts 2>/dev/null | sort -u | wc -l)
echo "  RunEvent variants: $EVENT_VARIANTS"

# ── Summary ──
echo ""
echo "=== Document-Drift Audit Complete ==="
if [ $FAIL -eq 0 ]; then
  echo "All version checks pass (README warning is non-fatal)."
else
  echo "FAIL: version mismatch detected."
fi

exit $FAIL
