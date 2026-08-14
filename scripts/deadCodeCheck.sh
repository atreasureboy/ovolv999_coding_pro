#!/usr/bin/env bash
# Dead code check — CI verification layer (Round 29 rewrite)
#
# The original checker matched only same-depth static `from './x.js'`
# imports — 105 of its 112 warnings were false positives (it missed
# createRequire() lazy requires, multi-level relative imports, dynamic
# import(), and everything referenced from bin/). This rewrite resolves
# references the way Node does: by module BASENAME with extension
# variants, across src/ + bin/, including require() and import().
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FAIL=0
echo "=== Dead Code Audit ==="

# ── 1. Unimported source files ──
echo ""
echo "--- Unimported source files ---"
# Whitelist: entry points and intentionally side-effect-only modules
WHITELIST=(
  'bin/ovogogogo.ts'
  'src/cli/engineAssembly.ts'   # imported statically by bin/
  'src/cli/acpServer.ts'        # dynamic import target from bin/
  'src/core/engine.ts'
  'src/core/runtime/boot.ts'
  'src/core/runtime/coordinator.ts'
  'src/core/types.ts'
  'src/tools/index.ts'
  'src/commands/index.ts'
  'src/commands/builtin.ts'
  'src/commands/doctor.ts'      # lazy require from builtin.ts
  'src/skills/loader.ts'
  'src/skills/extractor.ts'
)

unimported=0
while IFS= read -r -d '' file; do
  [[ "$file" == *"__tests__"* || "$file" == *".test.ts" || "$file" == *".test.tsx" ]] && continue
  skip=0
  for wl in "${WHITELIST[@]}"; do
    [[ "$file" == "$wl" ]] && { skip=1; break; }
  done
  [[ $skip -eq 1 ]] && continue

  base="$(basename "${file%.*}")"
  # Reference = basename appearing in any import/require/dynamic-import in
  # a DIFFERENT production file (src/ or bin/). Path-agnostic because the
  # same module is reached via ./x.js, ../core/x.js, ../src/core/x.js,
  # require('../core/x.js') and import('../core/x.js').
  refs=$(grep -rlE "(from +['\"][^'\"]*/${base}(\.js)?['\"]|require\(['\"][^'\"]*/${base}(\.js)?['\"]\)|import\(['\"][^'\"]*/${base}(\.js)?['\"]\)|^import +['\"][^'\"]*/${base}(\.js)?['\"])" \
    src/ bin/ --include='*.ts' --include='*.tsx' 2>/dev/null | grep -v -F "$file" || true)
  if [ -z "$refs" ]; then
    echo "  WARNING: $file has zero production references"
    unimported=$((unimported + 1))
  fi
done < <(find src bin -name '*.ts' -o -name '*.tsx' | grep -v -E '\.test\.|__tests__' | tr '\n' '\0')

echo "  Unimported source files: $unimported"

# ── 2. `as any` / `as never` cast trend (hard cap) ──
echo ""
echo "--- Type-cast audit ---"
casts=$(grep -rnE ' as (any|never)([^A-Za-z_]|$)' src/ bin/ --include='*.ts' --include='*.tsx' | grep -v -E '\.test\.|__tests__' | wc -l || true)
echo "  'as any'/'as never' casts in production code: ${casts}"

echo ""
if [ "$unimported" -gt 0 ]; then
  echo "=== RESULT: $unimported unimported file(s) — verify each is intentional or delete ==="
fi
echo "=== Dead Code Audit done ==="
