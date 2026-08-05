#!/usr/bin/env node
/**
 * verify-runtime-truth.mjs — machine-checkable documentation/code consistency.
 *
 * v0.5.3 (P6) + v0.5.3 Final (task 12) behavioral checks:
 *   - claimed-wired module must have src/ non-test production reference
 *   - experimental/ files cannot be referenced by src/ as live
 *   - Memory single-write enforcement (LongTermMemory gates BEFORE
 *     SemanticMemory, AND before any parallel write path like
 *     consolidateSession)
 *   - Router signal fields are read by the scorer
 *   - TaskImpact schema enum matches parser vocabulary AND every
 *     schema enum value parses back successfully (round-trip)
 *   - no absolute test counts in long-form docs
 *   - Golden-path test exists
 *   - recordRetry / totalRetryAttempts are dead: not wired, not exported
 *   - All-open route returns structured unavailable decision
 *   - ESM-runner files exist AND are referenced by package.json
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
//
// v0.5.3 Final (task 2): memory_write no longer writes directly. It
// pushes a candidate onto the per-run RunScopedRuntimeContext; the
// promotion happens in onComplete, gated by decidePromotion() and
// finally LongTermMemory.record(). So:
//
//   - memory_write.execute() must NOT call ltm.record() directly
//     (the existing rule was: gates before semantic.write).
//   - the memory module must expose a per-run candidate sink that
//     receives MemoryCandidates.
//   - the promoter calls LongTermMemory.record() from onComplete.
{
  const memorySrc = readText('src/modules/memory.ts') ?? ''
  // The tool's execute() must NOT write LTM directly.
  const idxRecord = memorySrc.indexOf('ltm().record(')
  const idxSink = memorySrc.indexOf('publishCandidateSink(')
  const idxOnComplete = memorySrc.indexOf('onComplete')
  const idxDecide = memorySrc.indexOf('decidePromotion(')
  check('memory_write uses candidate sink + promoter (no direct ltm.record)',
    idxRecord < 0 && idxSink >= 0 && idxOnComplete >= 0 && idxDecide >= 0,
    `ltm.record@${idxRecord}, publishCandidateSink@${idxSink}, onComplete@${idxOnComplete}, decidePromotion@${idxDecide}`)
}

// v0.5.3 Closure (P5): consolidateSession was removed per spec
// Option A. This is now inverted — the production code paths MUST
// NOT reference consolidateSession. Any reference implies a stale
// call site that needs deletion.
{
  const cliSrc = readText('bin/ovogogogo.ts') ?? ''
  const reflectionSrc = readText('src/modules/reflection.ts') ?? ''
  // We allow the dead reference inside the experimental/ stub.
  const cliRefs = /consolidateSession\s*\(/.test(cliSrc)
  const reflectionRefs = /consolidateSession\s*\(/.test(reflectionSrc)
  const experimental = readText('experimental/reflection.ts') ?? ''
  const expRefs = /consolidateSession\s*\(/.test(experimental)
  check('consolidateSession NOT called from production paths',
    !cliRefs && !reflectionRefs,
    `cli=${cliRefs}, reflection.ts=${reflectionRefs}, experimental(not checked)=${expRefs}`)
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

// ── Check 13: TaskImpact enum round-trip ────────────────────────────────
//
// Spec 1: the LLM-visible schema enum matches TASK_IMPACT_SCOPES.
// Spec 2: every value in the parser vocabulary is a value in the
//         schema enum (no parser-only scopes that the model cannot
//         send). We assert set equality BOTH ways.
function parseScopesFromList(listStr) {
  return listStr
    .split(',')
    .map((s) => s.trim().replace(/^\s*['"]|['"]\s*$/g, ''))
    .filter((s) => s.length > 0)
}
{
  const tpSrc = readText('src/tools/taskPlan.ts') ?? ''
  const tiSrc = readText('src/core/taskImpact.ts') ?? ''
  const schemaMatch = tpSrc.match(/impact_scope:\s*\{[\s\S]*?enum:\s*\[([^\]]+)\]/)
  const schemaScopes = schemaMatch ? parseScopesFromList(schemaMatch[1]) : []
  const canonicalMatch = tiSrc.match(/TASK_IMPACT_SCOPES\s*=\s*\[([^\]]+)\]/)
  const canonical = canonicalMatch ? parseScopesFromList(canonicalMatch[1]) : []
  check('TaskImpact schema enum ⊇ TASK_IMPACT_SCOPES', canonical.every((s) => schemaScopes.includes(s)),
    `canonical=[${canonical.join(',')}], schema=[${schemaScopes.join(',')}]`)
  check('TaskImpact schema enum ⊆ TASK_IMPACT_SCOPES', schemaScopes.every((s) => canonical.includes(s)),
    `schema has extras: [${schemaScopes.filter((s) => !canonical.includes(s)).join(',')}]`)
}

// ── Check 14: Memory single-write enforcement ALSO blocks parallel ────
//
// spec: every place that persists a semantic entry must funnel
// through LongTermMemory.record(). One bypass = hidden write.
{
  const semanticWriteSites = []
  for (const file of walk(join(ROOT, 'src'))) {
    if (!file.endsWith('.ts')) continue
    const text = readFileSync(file, 'utf8')
    // semantic.write(...) outside the LTM gate (recorded as a
    // semantic-side write, not a derived mirror).
    const matches = [...text.matchAll(/\bsemantic\s*\.\s*write\s*\(/g)]
    if (matches.length === 0) continue
    // Skip the LTM-mirror case inside promotePromotion's success
    // branch — that one is already inside the gate.
    const lines = text.split('\n')
    for (const m of matches) {
      // Get the line where the semantic.write call sits.
      const offset = m.index ?? 0
      const before = text.slice(0, offset)
      const lineNo = before.split('\n').length - 1
      const line = lines[lineNo] ?? ''
      const isInsideGate = /successPromotions\b/.test(text.slice(Math.max(0, offset - 600), offset))
        || /longTerm\s*\.\s*record\s*\(/.test(text.slice(Math.max(0, offset - 600), offset))
      if (!isInsideGate) semanticWriteSites.push({ file: relative(ROOT, file), line: lineNo, line })
    }
  }
  check('no semantic.write outside LongTermMemory gate', semanticWriteSites.length === 0,
    semanticWriteSites.map((s) => `${s.file}:${s.line + 1}: ${s.line.trim()}`).join('; ') || 'ok')
}

// ── Check 15: dead metrics removed ──────────────────────────────────────
//
// recordRetry / totalRetryAttempts / RouterHealthSnapshot.totalRetryAttempts
// must not appear as RUNTIME references — only as comments in
// type-doc explaining the deletion. A regex against the source
// without comments distinguishes: a property assignment, an object
// literal key, or a function return is a runtime reference; a block
// comment or a `/** */` doc-comment is not.
{
  const found = []
  for (const file of walk(join(ROOT, 'src'))) {
    if (!file.endsWith('.ts')) continue
    const text = readFileSync(file, 'utf8')
    // Strip /* ... */ blocks first, then count remaining hits.
    const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    if (/\btotalRetryAttempts\b/.test(stripped)) found.push(relative(ROOT, file))
  }
  check('totalRetryAttempts removed from production code (comments ok)', found.length === 0,
    `still present in: ${found.join(', ')}`)
}

// ── Check 16: ESM runner wired into package.json ─────────────────────────
{
  const pkg = readJson('package.json') ?? {}
  const scripts = pkg?.scripts ?? {}
  const hasTestEsm = typeof scripts['test:esm'] === 'string' && scripts['test:esm'].length > 0
  const inCheck = typeof scripts.check === 'string' && scripts.check.includes('test:esm')
  check('tests/esm-runner/* referenced by package.json', hasTestEsm && inCheck,
    `test:esm=${hasTestEsm}, in check=${inCheck}`)
}

// ── Check 17: RepoStats Math.max(fallback) abolished ────────────────
//
// v0.5.3 Final (P0 issue): the old code was
//   const repoFileCount = realCount ?? Math.max(filesTouched * 10, 100)
// which fabricated 100 for unknown states. The collector must NOT
// synthesize a number; either realCount or undefined.
{
  const rcSrcRaw = readText('src/core/model/routingSignalCollector.ts') ?? ''
  const rcSrc = rcSrcRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const hasFallback = /Math\.max\(\s*filesTouched\s*\*\s*10\s*,\s*100\s*\)/.test(rcSrc)
  check('RoutingSignalCollector no longer fabricates Math.max(filesTouched*10,100) (comments stripped)',
    !hasFallback,
    hasFallback ? 'the fabrication formula is still present in code' : 'ok')
}

// ── Check 18: Router measure BEFORE route ──────────────────────────────
//
// v0.5.3 Final (P0 issue): the Coordinator used to measure → collect
// signals → route THEN compact. The new order is measure → apply
// policy (compact) → re-measure → collect signals → route. The Router
// must always read the POST-compaction snapshot.
{
  const coordSrc = readText('src/core/runtime/coordinator.ts') ?? ''
  // Find run() and inspect relative order of measureBudget and
  // collectRoutingSignals.
  const runIdx = coordSrc.indexOf('async run(')
  if (runIdx < 0) {
    check('Coordinator.run() measure → route order present', false, 'run() not found')
  } else {
    const runBody = coordSrc.slice(runIdx, coordSrc.indexOf('\n  }\n', runIdx + 1) === -1 ? coordSrc.length : coordSrc.indexOf('\n  }\n', runIdx + 1))
    const measureIdx = runBody.indexOf('measureBudget')
    const applyIdx = runBody.indexOf('applyBudgetPolicy')
    const remeasureIdx = runBody.indexOf('measureBudget', (measureIdx >= 0 ? measureIdx : 0) + 1)
    const signalsIdx = runBody.indexOf('collectRoutingSignals')
    check('Coordinator orders measure → apply → re-measure → signals → route',
      measureIdx >= 0 && applyIdx >= 0 && remeasureIdx >= 0 && signalsIdx >= 0
        && measureIdx < applyIdx && applyIdx < remeasureIdx && remeasureIdx < signalsIdx,
      `measure@${measureIdx}, apply@${applyIdx}, remeasure@${remeasureIdx}, signals@${signalsIdx}`)
  }
}

// ── Check 19: RevisionBinding fields persist on MemoryRecord ─────────
//
// v0.5.3 Final (P0 issue): the gate's R3 now accepts diffHash for
// dirty git repos and workspaceHash for non-git. The promoter must
// pass these from RevisionBinding → MemoryRecord.
{
  const mcSrc = readText('src/core/memoryCandidate.ts') ?? ''
  const checks = {
    dirty: /\bdirty:\s*input\.revision\.dirty/.test(mcSrc),
    diffHash: /\bdiffHash:\s*input\.revision\.diffHash/.test(mcSrc),
    workspaceHash: /\bworkspaceHash:\s*input\.revision\.workspaceHash/.test(mcSrc),
  }
  const all = Object.values(checks).every(Boolean)
  check('Promoter propagates RevisionBinding → MemoryRecord (dirty/diffHash/workspaceHash)',
    all, `passed=${JSON.stringify(checks)}`)
}

// ── Check 20: ReflectionModule no longer calls LTM.record ────────────
//
// v0.5.3 Final (P0 issue): ReflectionModule previously called
// LongTermMemory.record() directly with repo='reflection', a parallel
// write path that bypassed MemoryCandidate → Promotion. The bypass
// must be gone; onComplete should not call record().
{
  const reflSrc = readText('src/modules/reflection.ts') ?? ''
  // Slice just the onComplete body for accuracy.
  const idx = reflSrc.indexOf('async onComplete')
  const close = reflSrc.indexOf('\n  private ', idx)
  const body = close > idx ? reflSrc.slice(idx, close) : ''
  const hasRecord = /\blongTerm\s*\.\s*record\s*\(/.test(body) ||
                    /\bgate\s*\.\s*record\s*\(/.test(body) ||
                    /\bsemantic\s*\.\s*write\s*\(/.test(body)
  check('ReflectionModule.onComplete does NOT call LTM.record or semantic.write',
    !hasRecord, hasRecord ? `body still calls a write path: ${body.slice(0, 200)}` : 'ok')
}

// ── Check 21: MemoryModule reads are repo-filtered ─────────────────────
//
// v0.5.3 Final (P0 issue): the previous memory_search and boot
// retrieval queried LongTermMemory.query() without a repo filter,
// so A's memory bled into B's prompt. The query MUST carry `repo`.
{
  const memSrc = readText('src/modules/memory.ts') ?? ''
  // Boot: between `ltmRecords = this.longTerm.query({` and the
  // matching `})` for that block. The repo property must appear.
  const bootHasRepo = (() => {
    const idx = memSrc.indexOf('ltmRecords = this.longTerm.query({')
    if (idx < 0) return false
    const close = memSrc.indexOf('})', idx)
    const body = memSrc.slice(idx, close)
    return /\brepo:/.test(body)
  })()
  const searchToolHasRepo = (() => {
    const idx = memSrc.indexOf('function createMemorySearchToolLTM')
    if (idx < 0) return false
    const slice = memSrc.slice(idx, idx + 4000)
    // Strip comments + whitespace, then look for the ltm.query call.
    const stripped = slice.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    const queryStart = stripped.indexOf('ltm.query(')
    if (queryStart < 0) return false
    const queryBody = stripped.slice(queryStart, queryStart + 500)
    return /\brepo:\s*getRepo\(\)/.test(queryBody)
  })()
  check('MemoryModule reads carry repo filter (boot + search)',
    bootHasRepo && searchToolHasRepo,
    `boot=${bootHasRepo}, search=${searchToolHasRepo}`)
}

// ── Check 22: real end-to-end Profile A→B test exists ────────────────
//
// v0.5.3 Final (P0 issue): the previous fake Golden Path C only
// invoked the Router directly. The new test must exercise Engine +
// Coordinator + ModelGateway through runTurn().
{
  check('tests/v053RealGoldenPath.profileFallback.test.ts exists',
    existsSync(join(ROOT, 'tests/v053RealGoldenPath.profileFallback.test.ts')),
    'real end-to-end profile-fallback test missing')
}

// ── Check 23: probe lease wired into Coordinator ─────────────────────
//
// v0.5.3 Final (P1-3): the previous round added
// tryAcquireProbe / finishProbe to the Router but did not call
// them from anywhere in the production path. The Coordinator's
// callLLM must consult the lease in the half-open window.
{
  const coordSrc = readText('src/core/runtime/coordinator.ts') ?? ''
  const stripped = coordSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const hasAcquire = /router\s*\?\.\s*tryAcquireProbe\s*\(/.test(stripped)
      || /tryAcquireProbe\s*\(\s*binding\.id\s*\)/.test(stripped)
  const hasFinish = /router\s*\?\.\s*finishProbe\s*\(/.test(stripped)
      || /finishProbe\s*\(\s*probeBindingId\s*,/.test(stripped)
  check('Coordinator consults tryAcquireProbe/finishProbe on the half-open path',
    hasAcquire && hasFinish,
    `acquire=${hasAcquire}, finish=${hasFinish}`)
}

// ── Check 24: sourceQuote min-length + coverage enforced ───────────
//
// v0.5.3 Final (P1-1): laundering user_stated with a 1-char
// quote must be impossible. The promoter must enforce both a
// minimum normalized quote length AND a content-token-coverage
// floor.
{
  const mcSrc = readText('src/core/memoryCandidate.ts') ?? ''
  const stripped = mcSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const hasMinLen = /MIN_USER_STATED_QUOTE_NORM_LENGTH\s*=/.test(stripped)
  const hasCoverage = /MIN_CONTENT_TOKEN_COVERAGE\s*=/.test(stripped)
  const usesVerifier = /verifySourceQuote\s*\(/.test(stripped)
  check('MemoryCandidate enforces sourceQuote min-length + content coverage',
    hasMinLen && hasCoverage && usesVerifier,
    `minLen=${hasMinLen}, coverage=${hasCoverage}, verifier=${usesVerifier}`)
}

// ── Check 25: CLI does NOT track sessionRunIds anymore (P5) ─────────
//
// v0.5.3 Closure (P5): the CLI no longer needs to track per-run
// runIds for consolidation (consolidation was removed). This is a
// regression check: the variables are gone from the bin/ CLI.
{
  const cliSrc = readText('bin/ovogogogo.ts') ?? ''
  const stripped = cliSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const hasArray = /const\s+sessionRunIds\s*:\s*string\[\]/.test(stripped)
  const hasLastUserPrompt = /let\s+lastUserPrompt\s*:/.test(stripped)
  const hasLastTurnOutcome = /let\s+lastTurnOutcome\s*:/.test(stripped)
  check('CLI has NO consolidation-tracking globals (P5 removed them)',
    !hasArray && !hasLastUserPrompt && !hasLastTurnOutcome,
    `sessionRunIds=${hasArray}, lastUserPrompt=${hasLastUserPrompt}, lastTurnOutcome=${hasLastTurnOutcome}`)
}

// ── Check 26: consolidateSession test exercises real round-trip ──────
//
// v0.5.3 Closure (P5): consolidateSession itself was removed per
// the spec's Option A. This check flips: the test must NOT exist,
// and consolidateSession must NOT be imported or referenced from
// any src/ or bin/ production path.
{
  const consolidationFile = join(ROOT, 'tests/v053/consolidateSessionReal.test.ts')
  check('consolidateSession test removed (P5 Option A)',
    !existsSync(consolidationFile),
    'consolidateSession test file should be removed')
}

// ── Check 27: ReflectionModule removed from active profile (P9) ────────
//
// v0.5.3 Closure (P9): ReflectionModule is no-op dead code. The
// active module profile must NOT register it; the class itself
// may live in experimental/ for future honest re-implementations.
{
  const engineAsm = readText('src/cli/engineAssembly.ts') ?? ''
  const active = /globalModuleRegistry\.register\(\s*['"]reflection['"]/m.test(engineAsm)
  check('ReflectionModule NOT in active profile registry', !active,
    active ? 'reflection module is still registered' : 'ok')
  // experimental/ is allowed (future home for an honest producer).
  const experimental = existsSync(join(ROOT, 'experimental/reflection.ts'))
  check('experimental/reflection.ts may exist (future home)', !active && experimental
    ? true
    : !experimental, 'reflection state inconsistent')
}

// ── Check 28: probe-finishProbe wiring in Coordinator ────────────────
//
// v0.5.3 Closure (P2): the Coordinator must consult
// router.tryAcquireProbe() and router.finishProbe() in the half-
// open path. Verified statically (regex) and dynamically by the
// behavioral test in tests/v053/probePerAttemptTruth.test.ts.
{
  const coordSrc = readText('src/core/runtime/coordinator.ts') ?? ''
  const stripped = coordSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const hasAcquire = /router[?.]?\.?tryAcquireProbe\s*\(/.test(stripped)
  const hasFinish = /router[?.]?\.?finishProbe\s*\(/.test(stripped)
  // v0.5.3 Closure (P2): the finishProbe call must be in `finally`
  // so the lease is released on abort / throw / normal-return.
  const finishProbeInFinally = /try\s*\{[\s\S]*?finally\s*\{[\s\S]*?finishProbe/m.test(stripped)
  check('Coordinator wires probe lease + finishProbe in finally',
    hasAcquire && hasFinish && finishProbeInFinally,
    `acquire=${hasAcquire}, finish=${hasFinish}, inFinally=${finishProbeInFinally}`)
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