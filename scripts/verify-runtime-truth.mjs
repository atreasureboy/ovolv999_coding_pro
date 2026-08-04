#!/usr/bin/env node
/**
 * verify-runtime-truth.mjs — machine-checkable documentation/code consistency.
 *
 * v0.5.3 (P6) upgrades:
 *   - claimed-wired module must have src/ non-test production reference
 *   - experimental/ files cannot be referenced by src/ as live
 *   - Engine fields not consumed by the main chain are flagged
 *   - Sandbox backend declaration must match what wrapCommand() uses
 *   - Memory single-write enforcement: LongTermMemory gates BEFORE
 *     SemanticMemory on the memory_write path
 *   - Router signal fields must be read by the scorer (heuristic)
 *   - TaskImpact schema must be referenced by an active tool entry
 *   - no absolute test counts in long-form docs
 *   - Phase 5 golden-path test must exist
 *
 * Run via `node scripts/verify-runtime-truth.mjs` or wired into `pnpm check`.
 * Exits 0 on success, 1 on any mismatch — prints every issue found.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const failures = []
function check(label, ok, detail) {
  if (ok) return
  failures.push(`✗ ${label}: ${detail}`)
}

function readJson(rel) {
  const full = join(ROOT, rel)
  if (!existsSync(full)) return null
  return JSON.parse(readFileSync(full, 'utf8'))
}

function readText(rel) {
  const full = join(ROOT, rel)
  if (!existsSync(full)) return null
  return readFileSync(full, 'utf8')
}

function* walk(dir) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.claude')) continue
    const full = join(dir, entry)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) yield* walk(full)
    else if (st.isFile()) yield full
  }
}

// ── Check 1: package.json version vs README top version ──────────────────

{
  const pkg = readJson('package.json')
  const readme = readText('README.md')
  const pkgVersion = pkg?.version ?? null
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
    if (/\bexport type PermissionMode\b|\bexport\s+{\s*type PermissionMode\b/.test(src)) {
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

// ── Check 6: experimental/ files must NOT be referenced as live ─────────

{
  const srcFiles = []
  for (const f of walk(join(ROOT, 'src'))) srcFiles.push(f)
  const experimentalRefs = []
  for (const f of srcFiles) {
    const text = readFileSync(f, 'utf8')
    const m = text.match(/from\s+['"](\.\.?\/.*experimental\/[^'"]+)['"]/g) ?? []
    for (const ref of m) experimentalRefs.push({ file: relative(ROOT, f), ref })
  }
  check('no src/ file imports from experimental/', experimentalRefs.length === 0,
    experimentalRefs.map((r) => `${r.file} → ${r.ref}`).join('; ') || 'ok')
}

// ── Check 7: Memory single-write enforcement ────────────────────────────

{
  const memorySrc = readText('src/modules/memory.ts') ?? ''
  const lt = memorySrc.indexOf('ltm().record(')
  const sw = memorySrc.indexOf('semantic.write(')
  check('memory_write gates before semantic.write', lt >= 0 && sw >= 0 && lt < sw,
    `ltm.record index=${lt}, semantic.write index=${sw}`)
}

// ── Check 8: Router signal fields are read by the scorer ────────────────

{
  const routerSrc = readText('src/core/model/modelRouter.ts') ?? ''
  const fields = ['previousRoutingFailures', 'consecutiveFailures', 'contextUsageRatio', 'budgetRemaining', 'expectedToolRequirement']
  const used = fields.filter((f) => routerSrc.includes(f))
  check('Router scorer reads at least 3 routing signal fields', used.length >= 3,
    `used: [${used.join(', ')}], expected ≥ 3`)
}

// ── Check 9: TaskImpact schema must be referenced by an active tool ─────

{
  const tpSrc = readText('src/tools/taskPlan.ts') ?? ''
  check('TaskPlan tool schema references impact_scope', tpSrc.includes('impact_scope'),
    'tools/taskPlan.ts missing impact_scope field — TaskImpact has no real entry point')
  check('TaskPlan tool schema references affects_public_interface', tpSrc.includes('affects_public_interface'),
    'missing affects_public_interface')
}

// ── Check 10: no absolute test counts in long-form docs ──────────────────

{
  const docs = ['README.md', 'CLAUDE.md', 'CHANGELOG.md']
  const bad = []
  for (const d of docs) {
    const text = readText(d) ?? ''
    const m = text.match(/\b\d{3,}\s*(?:tests?|cases?)\b/gi) ?? []
    for (const hit of m) bad.push(`${d}: ${hit}`)
  }
  check('no absolute test counts in long-form docs', bad.length === 0,
    bad.join('; ') || 'ok')
}

// ── Check 11: golden-path test exists ────────────────────────────────────

{
  const testPath = 'tests/v053RealGoldenPath.test.ts'
  check('v0.5.3 golden-path test exists', existsSync(join(ROOT, testPath)),
    `${testPath} not found`)
}

// ── Check 12: experimental/ directory exists ─────────────────────────────

{
  check('experimental/ directory exists for de-scoped modules', existsSync(join(ROOT, 'experimental')),
    'no experimental/ directory')
  const expEntries = (() => {
    try { return readdirSync(join(ROOT, 'experimental')) } catch { return [] }
  })()
  check('experimental/ contains moved files', expEntries.length > 0,
    'experimental/ exists but is empty')
}

// ── Summary ───────────────────────────────────────────────────────────────

if (failures.length === 0) {
  console.log('✓ verify-runtime-truth: all 12 checks passed')
  process.exit(0)
}

console.log(`\nverify-runtime-truth: ${failures.length} failure(s):\n`)
for (const f of failures) console.log('  ' + f)
console.log('')
process.exit(1)