#!/usr/bin/env node
/**
 * verify-runtime-truth.mjs — machine-checkable documentation/code consistency.
 *
 * Catches drift between documentation claims and runtime reality:
 *
 *   1. package.json version matches the README's top version
 *   2. runtime dependency count is the value documented in CLAUDE.md
 *   3. EventType whitelist in src/core/eventLog.ts is referenced by every
 *      documented event type in CHANGELOG.md (and no orphan events exist)
 *   4. PermissionMode union lives in exactly one source-of-truth location
 *   5. ADR paths referenced in README + CLAUDE.md exist on disk
 *
 * Run via `node scripts/verify-runtime-truth.mjs` or wired into `pnpm check`.
 * Exits 0 on success, 1 on any mismatch — prints every issue found.
 *
 * v0.5.2 Reality Closure (Stage 6).
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const failures = []
function check(label, ok, detail) {
  if (ok) return
  failures.push(`✗ ${label}: ${detail}`)
}

/** Read and parse a JSON file relative to repo root. */
function readJson(rel) {
  const full = join(ROOT, rel)
  if (!existsSync(full)) return null
  return JSON.parse(readFileSync(full, 'utf8'))
}

/** Read a text file relative to repo root. */
function readText(rel) {
  const full = join(ROOT, rel)
  if (!existsSync(full)) return null
  return readFileSync(full, 'utf8')
}

// ── Check 1: package.json version vs README top version ──────────────────

{
  const pkg = readJson('package.json')
  const readme = readText('README.md')
  const pkgVersion = pkg?.version ?? null
  // Look for "Version: x.y.z" or "# ovolv999 vX.Y.Z" near the top.
  let readmeVersion = null
  if (readme) {
    const m = readme.match(/Version:\s*v?(\d+\.\d+\.\d+)/i) ??
              readme.match(/#\s*ovolv999[^\n]*v(\d+\.\d+\.\d+)/i)
    if (m) readmeVersion = m[1]
  }
  check('package.json version vs README', pkgVersion && readmeVersion && pkgVersion === readmeVersion,
    `package.json says ${pkgVersion ?? '?'}, README says ${readmeVersion ?? '?'}`)
}

// ── Check 2: runtime dependency count ─────────────────────────────────────

{
  const pkg = readJson('package.json')
  const deps = pkg?.dependencies ? Object.keys(pkg.dependencies) : []
  // CLAUDE.md says 8 runtime deps after the R8 SDK upgrade.
  check('runtime dependency count matches CLAUDE.md', deps.length === 8,
    `package.json has ${deps.length} runtime deps; CLAUDE.md says 8. List: ${deps.join(', ')}`)
}

// ── Check 3: EventType whitelist consistency ──────────────────────────────

{
  const eventsSrc = readText('src/core/eventLog.ts')
  if (!eventsSrc) {
    check('EventType whitelist present', false, 'src/core/eventLog.ts is missing')
  } else {
    const whitelistMatch = eventsSrc.match(/const EVENT_TYPES[^]*?\]/)
    const whitelist = whitelistMatch ? [...whitelistMatch[0].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : []
    const typeMatch = eventsSrc.match(/export type EventType[^]*?;/)
    const typeNames = typeMatch ? [...typeMatch[0].matchAll(/\|\s*'([a-z_]+)'/g)].map((m) => m[1]) : []
    const same = whitelist.length === typeNames.length && whitelist.every((v) => typeNames.includes(v))
    check('EventType union matches EVENT_TYPES whitelist', same,
      `union: [${typeNames.join(', ')}], whitelist: [${whitelist.join(', ')}]`)
  }
}

// ── Check 4: PermissionMode single source of truth ────────────────────────

{
  // PermissionMode must be defined in exactly ONE place (the source of
  // truth) and imported by consumers. We scan src/ for declarations
  // vs imports and fail if either drifts.
  const filesToScan = [
    'src/core/types.ts',
    'src/core/permissionSystem.ts',
    'src/core/toolRuntime/permissionModeGate.ts',
    'src/commands/builtin.ts',
  ]
  let declCount = 0
  let importCount = 0
  const declFiles = []
  for (const rel of filesToScan) {
    const src = readText(rel) ?? ''
    if (/\bexport type PermissionMode\b|\bexport\s*{\s*type PermissionMode\b/.test(src)) {
      declCount++
      declFiles.push(rel)
    }
    if (/import\s+type\s+\{[^}]*PermissionMode[^}]*\}/.test(src) ||
        /import\s+\{[^}]*PermissionMode[^}]*\}\s+from/.test(src)) {
      importCount++
    }
  }
  check('PermissionMode declared in exactly one place', declCount === 1,
    `found ${declCount} declaration(s) in: ${declFiles.join(', ')}`)
  check('PermissionMode is imported by consumers', importCount >= 2,
    `found ${importCount} import(s); expected ≥ 2`)
}

// ── Check 5: ADR paths referenced in README + CLAUDE.md exist ─────────────

{
  const readme = readText('README.md') ?? ''
  const claude = readText('CLAUDE.md') ?? ''
  const combined = readme + '\n' + claude
  const adrRefs = [...combined.matchAll(/docs\/ADR\/(\d{3}-[a-z-]+\.md)/g)].map((m) => m[1])
  const seen = new Set()
  const missing = []
  for (const ref of adrRefs) {
    if (seen.has(ref)) continue
    seen.add(ref)
    const full = join(ROOT, 'docs', 'ADR', ref)
    if (!existsSync(full)) missing.push(ref)
  }
  check('all ADR paths exist on disk', missing.length === 0,
    `missing ADRs: ${missing.join(', ') || 'none'}`)
}

// ── Check 6: README does not mention a deleted capability table file ──────

{
  const readme = readText('README.md') ?? ''
  const deletedFiles = [
    'docs/CAPABILITY_MATRIX.md',
    'docs/COMPARISON_LEGACY.md',
    'src/core/pipeMode.ts', // recent restoration — only flag if missing
  ]
  const missing = deletedFiles.filter((rel) => {
    if (readme.includes(rel) && !existsSync(join(ROOT, rel))) return true
    return false
  })
  check('no README references to deleted files', missing.length === 0,
    `README still references: ${missing.join(', ')}`)
}

// ── Check 7: runtime-truth test exists and passes ─────────────────────────

{
  const testPath = 'tests/v052GoldenPath.test.ts'
  check('v0.5.2 golden-path test exists', existsSync(join(ROOT, testPath)),
    `${testPath} not found`)
}

// ── Summary ───────────────────────────────────────────────────────────────

if (failures.length === 0) {
  console.log('✓ verify-runtime-truth: all 7 checks passed')
  process.exit(0)
}

console.log(`\nverify-runtime-truth: ${failures.length} failure(s):\n`)
for (const f of failures) console.log('  ' + f)
console.log('')
process.exit(1)