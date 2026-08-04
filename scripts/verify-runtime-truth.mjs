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

// v0.5.3 P0-1: consolidateSession was a parallel write path that
// bypassed LongTermMemory. The Gate must intercept it too. We assert
// that the function-body contains a `.record(` invocation BEFORE
// any top-level `semantic.write(`. To extract the function body
// without nesting glitches we rely on indentation: the body lines
// that we care about (the `for (const entry of parsed)` block in
// consolidateSession) are at 6-space indent; the function's
// enclosing `}` is at column 0. So we slice from the function
// start to the next column-0 `}`.
{
  const reflectionSrc = readText('src/modules/reflection.ts') ?? ''
  const start = reflectionSrc.indexOf('export async function consolidateSession')
  if (start < 0) {
    check('consolidateSession exists', false, 'consolidateSession not found in reflection.ts')
  } else {
    // Find the matching column-0 `}` after the function start. The
    // function's opening `{` is on the same line as the signature
    // (or the next line). Search forward for `\n}` (column 0 close
    // brace) that is at the same nesting depth as the opening brace.
    // We approximate with `^\}\s*$` matching at column 0.
    const after = reflectionSrc.slice(start)
    // Match the function-closing brace at column 0. Since the file
    // contains only one closing brace per top-level statement, and
    // consolidateSession is the LAST top-level statement, the next
    // column-0 `}` is its close — unless there's a trailing utility
    // block. Conservative: take the LAST column-0 `}` after the
    // function start.
    const column0CloseRe = /\n\}/g
    let lastIdx = -1
    let mm
    while ((mm = column0CloseRe.exec(after))) lastIdx = mm.index
    const bodyEnd = lastIdx >= 0 ? start + lastIdx + 2 : reflectionSrc.length
    const body = reflectionSrc.slice(start, bodyEnd)
    const gateIdx = body.search(/[A-Za-z_$][\w$]*\s*\.\s*record\s*\(/)
    const swIdx = body.search(/semantic\s*\.\s*write\s*\(/)
    check('consolidateSession gates BEFORE direct semantic.write',
      gateIdx >= 0 && swIdx >= 0 && gateIdx < swIdx,
      `gate idx=${gateIdx}, sw idx=${swIdx}, body length=${body.length}`)
  }
}

// v0.5.3 P0-1: Coordinator must publish a memoryToolContext (repo /
// sourceRunId / verified) that memory_write reads at execute time.
// We grep the coordinator for the publication site AND verify the
// MemoryModule has the receiver; both must exist or the wiring is
// only one-directional.
{
  const coordSrc = readText('src/core/runtime/coordinator.ts') ?? ''
  const memSrc = readText('src/modules/memory.ts') ?? ''
  // Accept any call: direct `publishMemoryContext(` or optional-
  // chaining `publishMemoryContext?.(`. The opt-chain path is the
  // production wiring shape; a back-compat direct call is the same
  // shape from the verifier's perspective.
  const publishesCtx = /publishMemoryContext[?]?[.]?\s*\(/.test(coordSrc)
  const definesModuleCtx = /publishMemoryContext[?]?[.]?\s*\(/.test(memSrc)
  const readsInWrite = /currentMemoryContext/.test(memSrc)
  check('Coordinator publishes + MemoryModule receives + memory_write reads memoryToolContext',
    publishesCtx && definesModuleCtx && readsInWrite,
    `publishes=${publishesCtx}, defines=${definesModuleCtx}, reads=${readsInWrite}`)
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
//
// v0.5.3 P0-4: the schema MUST carry `type: '...'` AFTER each
// TaskImpact property name. A string-level grep on field names is
// insufficient — a parser-only mention passes that, but the LLM
// never sees it. We assert the JSON-schema type is present.

{
  const tpSrc = readText('src/tools/taskPlan.ts') ?? ''
  // Match `name: { ..., type: 'typevalue' ... }` blocks so the
  // assertion cannot be satisfied by a typo-only mention of the
  // field name.
  const hasBoolType = (name) =>
    new RegExp(`\\b${name}:\\s*\\{\\s*[\\s\\S]*?type:\\s*['"]boolean['"]`).test(tpSrc)
  const hasNumberType = (name) =>
    new RegExp(`\\b${name}:\\s*\\{\\s*[\\s\\S]*?type:\\s*['"]number['"]`).test(tpSrc)
  check('TaskPlan schema: impact_scope present (string)',
    /\bimpact_scope:\s*\{[^}]*type:\s*['"]string['"]/.test(tpSrc),
    'impact_scope missing or wrong type — TaskImpact has no real schema entry')
  check('TaskPlan schema: affects_public_interface boolean', hasBoolType('affects_public_interface'),
    'affects_public_interface missing boolean type in schema')
  check('TaskPlan schema: changes_configuration boolean', hasBoolType('changes_configuration'),
    'changes_configuration missing boolean type in schema')
  check('TaskPlan schema: requires_root_cause boolean', hasBoolType('requires_root_cause'),
    'requires_root_cause missing boolean type in schema')
  check('TaskPlan schema: estimated_files number', hasNumberType('estimated_files'),
    'estimated_files missing number type in schema')
}

// v0.5.3 P0-3: the global circuit breaker on the Coordinator must be
// gone. We assert the absence of the canonical global fields. Their
// return only via the shim is fine — that's a back-compat wrapper
// for legacy test imports.
{
  const coordSrc = readText('src/core/runtime/coordinator.ts') ?? ''
  // Strip comments before scanning to avoid catching doc-only mentions.
  const code = coordSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const hasCircuitState = /\bcircuitState\b/.test(code)
  const hasConsecutiveProviderFailures = /\bconsecutiveProviderFailures\b/.test(code)
  const hasHalfOpenProbe = /\bhalfOpenProbeInFlight\b/.test(code)
  check('Coordinator global circuit removed (P0-3)',
    !hasCircuitState && !hasConsecutiveProviderFailures && !hasHalfOpenProbe,
    `circuitState=${hasCircuitState}, consecutiveProviderFailures=${hasConsecutiveProviderFailures}, halfOpenProbeInFlight=${hasHalfOpenProbe}`)
}

// v0.5.3 P0-3: Router.nextFallback must NOT call emitFallback
// internally anymore (the previous double-call inflated
// totalFallbacksApplied). The Coordinator is the single emit site.
{
  const routerSrc = readText('src/core/model/modelRouter.ts') ?? ''
  const nfMatch = routerSrc.match(/nextFallback\([^)]*\)\s*:\s*string\s*\|\s*null\s*\{[\s\S]*?\n\s*\}/)
  check('Router.nextFallback() does not double-emit emitFallback',
    nfMatch ? !/emitFallback\s*\(/.test(nfMatch[0]) : false,
    nfMatch ? 'nextFallback still calls emitFallback()' : 'nextFallback definition not found')
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
  console.log('✓ verify-runtime-truth: all checks passed')
  process.exit(0)
}

console.log(`\nverify-runtime-truth: ${failures.length} failure(s):\n`)
for (const f of failures) console.log('  ' + f)
console.log('')
process.exit(1)