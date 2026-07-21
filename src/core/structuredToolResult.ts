/**
 * Structured ToolResult (fi_goal.md §六 Phase 5).
 *
 * Replaces ad-hoc `{content, isError}` flattening with a structured
 * shape carrying exitCode, stdout, stderr, artifacts, diagnostics,
 * and retry hint. The legacy 2-field shape remains valid; this
 * module supplies:
 *
 *   - the new `StructuredToolResult` interface
 *   - the union type `AnyToolResult` (legacy | structured)
 *   - helpers `toStructured()` / `toLegacy()` / `isStructuredResult()`
 *
 * ## Backward-compat policy
 *
 * Existing tools return `{content, isError}`. The ToolExecutor
 * normalizes both shapes via `toLegacy()` at the boundary so the
 * model API, scheduler, and UI keep working unchanged. New tools
 * (and tools that opt-in to richer reporting) construct a
 * StructuredToolResult directly.
 *
 * ## Spec'd invariants
 *
 *   - Bash non-zero exitCode → status='failed' (never 'success')
 *   - On failure, stdout AND stderr are retained (not elided)
 *   - Parent agents read `status`, not text, to determine success
 *   - Large outputs (> 8 KiB by default) are moved to an ArtifactRef
 *     so they don't bloat the conversation context
 */

import type { ArtifactRef } from './executionRun.js'

// ── Spec interface ──────────────────────────────────────────────────────

export type ToolResultStatus = 'success' | 'failed' | 'cancelled' | 'timed_out'

export interface Diagnostic {
  /** 'eslint' | 'tsc' | 'vitest' | 'ruff' | etc. */
  source: string
  /** 'error' | 'warning' | 'info' */
  severity: 'error' | 'warning' | 'info'
  message: string
  /** File path the diagnostic attaches to, when applicable. */
  file?: string
  line?: number
  column?: number
  /** Diagnostic code from the linter/compiler (e.g. 'no-unused-vars'). */
  code?: string
}

export interface StructuredToolResult {
  /** Outcome of the call. */
  status: ToolResultStatus
  /** One-line human-readable summary suitable for the model. */
  summary: string

  /** Process exit code (Bash, BackgroundTask, anything that exec()s). */
  exitCode?: number
  /** Captured stdout (truncated when large; see ArtifactRef). */
  stdout?: string
  /** Captured stderr (truncated when large). */
  stderr?: string

  /** References to logs/diffs/test-reports/patches stored out-of-band. */
  artifacts?: ArtifactRef[]
  /** Structured diagnostics emitted by linters / compilers / test runners. */
  diagnostics?: Diagnostic[]
  /**
   * Hint that the caller may sensibly retry this call after a backoff
   * (e.g. transient network, file lock, race). When false or absent,
   * the caller should not retry without changing the inputs.
   */
  retryable?: boolean

  /**
   * Verbose content for the model — used as the legacy `content` field
   * by `toLegacy()`. When omitted, the summary is used.
   */
  content?: string
}

/**
 * Union shape returned by Tool.execute(). Tools may return either
 * the legacy 2-field form or the structured form. The executor
 * normalizes via `toLegacy()` before sending to the model API.
 */
export type AnyToolResult = StructuredToolResult | LegacyToolResult

export interface LegacyToolResult {
  content: string
  isError: boolean
}

// ── Type guard ──────────────────────────────────────────────────────────

export function isStructuredResult(r: AnyToolResult): r is StructuredToolResult {
  return (
    typeof r === 'object' &&
    r !== null &&
    typeof (r as StructuredToolResult).status === 'string' &&
    typeof (r as StructuredToolResult).summary === 'string'
  )
}

// ── Normalizers ─────────────────────────────────────────────────────────

/**
 * Normalize any tool result to the structured shape. Legacy
 * `{content, isError}` is mapped:
 *
 *   isError=false → status='success',   summary=content
 *   isError=true  → status='failed',    summary=content
 *
 * (The legacy shape has no 'cancelled' / 'timed_out' distinction,
 * so both collapse to 'failed'. Tools that need the distinction
 * must return the structured shape directly.)
 */
export function toStructured(r: AnyToolResult): StructuredToolResult {
  if (isStructuredResult(r)) return r
  return {
    status: r.isError ? 'failed' : 'success',
    summary: r.content,
    content: r.content,
  }
}

/**
 * Flatten any tool result to the legacy 2-field shape used by the
 * model API and downstream UI/scheduler code. The mapping is:
 *
 *   status='success'         → isError=false
 *   status='failed'          → isError=true
 *   status='cancelled'       → isError=true
 *   status='timed_out'       → isError=true
 *
 * `content` is derived from (in priority order):
 *   1. result.content   (when the structured shape set it explicitly)
 *   2. stdout+stderr    (when present, with separators)
 *   3. summary          (fallback)
 */
export function toLegacy(r: AnyToolResult): LegacyToolResult {
  if (!isStructuredResult(r)) return r
  const isError = r.status !== 'success'
  const content = pickLegacyContent(r)
  return { content, isError }
}

function pickLegacyContent(r: StructuredToolResult): string {
  if (r.content !== undefined && r.content !== '') return r.content
  const parts: string[] = []
  if (r.stdout) parts.push(r.stdout)
  if (r.stderr) parts.push(r.stderr)
  if (parts.length > 0) {
    const code = r.exitCode !== undefined ? `Exit code: ${r.exitCode}\n` : ''
    return code + parts.join('\n--- stderr ---\n')
  }
  return r.summary
}

// ── Constructors ────────────────────────────────────────────────────────

/**
 * Build a successful structured result with sensible defaults.
 *
 *   ok({summary:'wrote file.ts', stdout:'1 file', artifacts:[...]})
 */
export function ok(fields: {
  summary: string
  stdout?: string
  stderr?: string
  exitCode?: number
  artifacts?: ArtifactRef[]
  diagnostics?: Diagnostic[]
  content?: string
}): StructuredToolResult {
  return { status: 'success', retryable: false, ...fields }
}

/**
 * Build a failed structured result. `exitCode` defaults to 1 when
 * not supplied, since most failures are non-zero process exits.
 */
export function failed(fields: {
  summary: string
  stdout?: string
  stderr?: string
  exitCode?: number
  artifacts?: ArtifactRef[]
  diagnostics?: Diagnostic[]
  retryable?: boolean
  content?: string
}): StructuredToolResult {
  return {
    status: 'failed',
    exitCode: 1,
    retryable: false,
    ...fields,
  }
}

/** Build a cancelled structured result. */
export function cancelled(summary: string, content?: string): StructuredToolResult {
  return { status: 'cancelled', summary, content, retryable: false }
}

/** Build a timed-out structured result. */
export function timedOut(summary: string, opts: { stdout?: string; stderr?: string } = {}): StructuredToolResult {
  return {
    status: 'timed_out',
    summary,
    stdout: opts.stdout,
    stderr: opts.stderr,
    retryable: true,
  }
}

// ── Large-output routing ────────────────────────────────────────────────

/**
 * Default byte threshold above which stdout/stderr should be moved
 * into an ArtifactRef and replaced with a short pointer in the
 * structured result. The spec §六 says "大体积输出写入 Artifact Store".
 */
export const DEFAULT_LARGE_OUTPUT_BYTES = 8 * 1024

/**
 * If `output` exceeds the threshold, build an ArtifactRef shape
 * (caller is responsible for actually writing the bytes to the
 * store). Returns `null` when output is small enough to keep inline.
 *
 * The returned tuple is `[artifact, truncated]` where `truncated` is
 * the head/tail preview the caller may put into stdout/stderr so the
 * model still sees a hint of what was captured.
 */
export function routeLargeOutput(
  output: string,
  artifactId: string,
  threshold: number = DEFAULT_LARGE_OUTPUT_BYTES,
): { artifact: ArtifactRef; preview: string } | null {
  if (output.length <= threshold) return null
  const head = output.slice(0, threshold >> 1)
  const tail = output.slice(-(threshold >> 1))
  const preview = `${head}\n... [${output.length - threshold} bytes truncated; see artifact ${artifactId}] ...\n${tail}`
  return {
    artifact: {
      id: artifactId,
      kind: 'log',
      contentType: 'text/plain',
      sizeBytes: output.length,
    },
    preview,
  }
}
