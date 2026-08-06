#!/usr/bin/env bash
# Dead code check — CI verification layer (super_plan.md Round 5.3)
# Detects:
#   1. Source files with zero production importers (excluding barrels/entry points)
#   2. @deprecated annotations with active callers
#   3. `as never` / `as any` type-cast count and trends
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FAIL=0
echo "=== Dead Code Audit ==="

# ── 1. Unimported source files ──
echo ""
echo "--- Unimported source files ---"
# Whitelist: entry points, barrel files, type-only definitions
WHITELIST=(
  'src/tools/index.ts'       # barrel
  'src/core/index.ts'        # barrel (if exists)
  'src/core/types.ts'        # type-only
  'src/core/providers.ts'    # type+constant
  'src/core/runtime/events.ts' # protocol
  'src/core/model/modelRouter.ts'
  'src/core/model/modelGateway.ts'
  'src/core/model/providerAdapter.ts'
  'src/core/model/streamConsumer.ts'
  'src/core/engine.ts'       # entry
  'src/core/runtime/coordinator.ts' # entry
  'src/core/runtime/boot.ts' # entry
  'src/core/toolRuntime/toolExecutor.ts'
  'src/core/toolRuntime/toolScheduler.ts'
  'src/core/toolRuntime/toolRegistry.ts'
  'src/core/toolRuntime/toolPolicy.ts'
  'src/core/context/contextManager.ts'
  'src/core/moduleRuntime/moduleManager.ts'
  'src/core/executionContext.ts'
  'src/core/executionRun.ts'
  'src/core/eventLog.ts'
  'src/core/semanticMemory.ts'
  'src/core/episodicMemory.ts'
  'src/core/fileHistory.ts'
  'src/core/backgroundTaskManager.ts'
  'src/core/permissionSystem.ts'
  'src/core/agentPresets.ts'
  'src/commands/builtin.ts'  # slash commands
  'src/ui/ink/runInkRepl.ts' # UI entry
  'src/integrations/acp.ts'  # protocol entry
)

unimported=0
while IFS= read -r -d '' file; do
  # Skip test files
  [[ "$file" == *".test.ts" ]] && continue
  # Skip whitelist
  skip=0
  for wl in "${WHITELIST[@]}"; do
    [[ "$file" == "$wl" ]] && { skip=1; break; }
  done
  [[ $skip -eq 1 ]] && continue

  # Check if any non-test file (other than itself) references this module path
  mod="${file%.ts}"
  # Check for imports of the form "from '.../module'" or "from '.../module.js'"
  import_refs=$(grep -rl "from.*['\"].*${mod##*/}['\"]" src/ --include='*.ts' 2>/dev/null | grep -v "$file" | grep -v '\.test\.ts' || true)
  # Also check for direct path imports
  import_refs2=$(grep -rl "from.*['\"]\.\.*\/${mod##*/}['\"]" src/ --include='*.ts' 2>/dev/null | grep -v "$file" | grep -v '\.test\.ts' || true)
  # Also check for dynamic imports
  import_refs3=$(grep -rl "import.*['\"]\.\.*\/${mod##*/}\.js['\"]" src/ --include='*.ts' 2>/dev/null | grep -v "$file" | grep -v '\.test\.ts' || true)

  if [ -z "$import_refs" ] && [ -z "$import_refs2" ] && [ -z "$import_refs3" ]; then
    echo "  WARNING: $file has zero production importers"
    unimported=$((unimported + 1))
  fi
done < <(find src -name '*.ts' -not -name '*.test.ts' -not -name '*.d.ts' -print0)

echo "  Unimported source files: $unimported"

# ── 2. @deprecated with active callers ──
echo ""
echo "--- @deprecated active callers ---"
deprecated_count=0
while IFS= read -r line; do
  file=$(echo "$line" | cut -d: -f1)
  symbol=$(echo "$line" | grep -oP '@deprecated\s+\K\w+' 2>/dev/null || true)
  if [ -n "$symbol" ]; then
    callers=$(grep -rl "$symbol" src/ --include="*.ts" 2>/dev/null | grep -v "$file" | grep -v '\.test\.ts' || true)
    if [ -z "$callers" ]; then
      echo "  OK: @deprecated '$symbol' in $file — zero production callers"
    else
      echo "  NOTE: @deprecated '$symbol' in $file — still called by:"
      echo "$callers" | sed 's/^/        /'
      deprecated_count=$((deprecated_count + 1))
    fi
  fi
done < <(grep -rn '@deprecated' src/ --include='*.ts' 2>/dev/null || true)

echo "  Deprecated-with-callers: $deprecated_count"

# ── 3. as never / as any usage ──
echo ""
echo "--- Type-cast audit (as never / as any) ---"
never_count=$(grep -r 'as never' src/ --include='*.ts' -c 2>/dev/null | awk -F: '{sum+=$2} END {print sum+0}')
any_count=$(grep -r 'as any' src/ --include='*.ts' -c 2>/dev/null | awk -F: '{sum+=$2} END {print sum+0}')
echo "  as never: $never_count occurrences"
echo "  as any:   $any_count occurrences"

# ── Summary ──
echo ""
echo "=== Dead Code Audit Complete ==="
if [ $unimported -gt 130 ]; then
  echo "WARNING: $unimported unimported source files detected (threshold: 130)"
  FAIL=1
else
  echo "Passes: unimported files (≤130) | deprecated check | type-cast count"
fi

exit $FAIL
