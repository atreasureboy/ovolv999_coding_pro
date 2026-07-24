/**
 * VCR — Record/Replay for API Calls
 *
 * Records LLM API responses to fixture files, then replays them in tests.
 * This eliminates network dependency, flaky tests, and API costs in CI.
 *
 * Mode:
 *   - record: Make real API calls, save response to fixture
 *   - replay: Load fixture, return saved response (no network)
 *   - auto: Replay if fixture exists, else record
 *
 * Fixture matching: normalizes input messages (dehydrates paths, UUIDs,
 * timestamps) and hashes them to a stable filename.
 *
 * Usage in tests:
 *   const vcr = new VCR({ mode: 'replay', fixtureDir: 'tests/fixtures' })
 *   const response = await vcr.intercept(client.chat.completions, 'create', params)
 *
 *   // Or as a wrapper:
 *   const mockClient = vcr.wrapClient(realClient)
 */

import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs'
import { join, resolve } from 'path'

// ── Types ───────────────────────────────────────────────────────────────────

export type VCRMode = 'record' | 'replay' | 'auto'

export interface VCRConfig {
  mode: VCRMode
  fixtureDir: string
  /** Whether to dehydrate paths/UUIDs/timestamps before hashing */
  dehydrate?: boolean
  /** Prefix for fixture files */
  filePrefix?: string
  /** Whether to throw on missing fixture in replay mode */
  strict?: boolean
}

export interface VCRStats {
  recorded: number
  replayed: number
  cached: number
  errors: number
}

// ── Dehydration ─────────────────────────────────────────────────────────────

/**
 * Dehydrate input to produce stable fixture keys across machines/runs.
 * Replaces:
 *   - Absolute paths → <PATH>
 *   - UUIDs → <UUID>
 *   - ISO timestamps → <TIMESTAMP>
 *   - CWD-specific values → <CWD>
 */
export function dehydrate(text: string): string {
  return text
    // Absolute paths (unix)
    .replace(/\/(?:home|Users)[^"\s]*/g, '<PATH>')
    .replace(/\/tmp[^"\s]*/g, '<PATH>')
    .replace(/\/project[^"\s]*/g, '<PATH>')
    // UUIDs
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<UUID>')
    // ISO timestamps
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<TIMESTAMP>')
    // Epoch millis
    .replace(/\b1[6-9]\d{11}\b/g, '<TIMESTAMP>')
    // Session IDs (session_YYYY-MM-DD_HHMMSS)
    .replace(/session_\d{4}-\d{2}-\d{2}_\d{6}/g, '<SESSION>')
}

/**
 * Compute a stable hash for a set of API call parameters.
 * Used as the fixture filename.
 */
export function computeCallHash(
  method: string,
  params: unknown,
  dehydrateInput = true,
): string {
  const json = JSON.stringify(params, null, 2)
  const normalized = dehydrateInput ? dehydrate(json) : json
  const hash = createHash('sha256').update(normalized).digest('hex')
  return `${method}_${hash.slice(0, 16)}`
}

// ── VCR Class ───────────────────────────────────────────────────────────────

export class VCR {
  private config: Required<VCRConfig>
  private stats: VCRStats = { recorded: 0, replayed: 0, cached: 0, errors: 0 }

  constructor(config: VCRConfig) {
    this.config = {
      dehydrate: true,
      filePrefix: 'vcr',
      strict: true,
      ...config,
    }

    if (this.config.mode !== 'replay') {
      mkdirSync(this.config.fixtureDir, { recursive: true })
    }
  }

  /**
   * Get the fixture path for a given call.
   */
  fixturePath(method: string, params: unknown): string {
    const hash = computeCallHash(method, params, this.config.dehydrate)
    return join(resolve(this.config.fixtureDir), `${this.config.filePrefix}_${hash}.json`)
  }

  /**
   * Check if a fixture exists for the call.
   */
  hasFixture(method: string, params: unknown): boolean {
    return existsSync(this.fixturePath(method, params))
  }

  /**
   * Load a fixture from disk.
   */
  loadFixture(method: string, params: unknown): unknown {
    const path = this.fixturePath(method, params)
    if (!existsSync(path)) {
      if (this.config.strict) {
        throw new VCRFixtureNotFoundError(method, path)
      }
      return null
    }
    const raw = readFileSync(path, 'utf8')
    return JSON.parse(raw)
  }

  /**
   * Save a response to a fixture.
   */
  saveFixture(method: string, params: unknown, response: unknown): void {
    const path = this.fixturePath(method, params)
    const content = JSON.stringify(response, null, 2)
    writeFileSync(path, content, 'utf8')
  }

  /**
   * Intercept an API call — record or replay based on mode.
   *
   * Usage:
   *   const result = await vcr.intercept(client.chat.completions, 'create', {
   *     model: 'gpt-4o',
   *     messages: [...],
   *   })
   */
  async intercept<T>(
    target: { [K: string]: (args: unknown) => Promise<T> },
    method: string,
    params: unknown,
  ): Promise<T> {
    const fixtureExists = this.hasFixture(method, params)

    // Replay mode: must have fixture
    if (this.config.mode === 'replay') {
      if (!fixtureExists) {
        this.stats.errors++
        throw new VCRFixtureNotFoundError(method, this.fixturePath(method, params))
      }
      this.stats.replayed++
      return this.loadFixture(method, params) as T
    }

    // Record mode: always make real call
    if (this.config.mode === 'record') {
      if (fixtureExists) {
        this.stats.cached++
        return this.loadFixture(method, params) as T
      }
      const result = await target[method](params)
      this.saveFixture(method, params, result)
      this.stats.recorded++
      return result
    }

    // Auto mode: replay if exists, else record
    if (fixtureExists) {
      this.stats.replayed++
      return this.loadFixture(method, params) as T
    }

    const result = await target[method](params)
    this.saveFixture(method, params, result)
    this.stats.recorded++
    return result
  }

  /**
   * Get statistics about recorded/replayed calls.
   */
  getStats(): Readonly<VCRStats> {
    return Object.freeze({ ...this.stats })
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.stats = { recorded: 0, replayed: 0, cached: 0, errors: 0 }
  }

  /**
   * List all fixtures in the directory.
   */
  listFixtures(): string[] {
    if (!existsSync(this.config.fixtureDir)) return []
    return readdirSync(this.config.fixtureDir)
      .filter(f => f.startsWith(this.config.filePrefix) && f.endsWith('.json'))
      .map(f => join(this.config.fixtureDir, f))
  }

  /**
   * Delete all fixtures (useful for re-recording).
   */
  clearFixtures(): number {
    const fixtures = this.listFixtures()
    for (const f of fixtures) {
      try { unlinkSync(f) } catch { /* skip */ }
    }
    return fixtures.length
  }
}

// ── Errors ──────────────────────────────────────────────────────────────────

export class VCRError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VCRError'
  }
}

export class VCRFixtureNotFoundError extends VCRError {
  method: string
  fixturePath: string

  constructor(method: string, fixturePath: string) {
    super(
      `VCR fixture not found for "${method}". Expected at: ${fixturePath}\n` +
      `Re-run tests with VCR_RECORD=1 to record new fixtures.`,
    )
    this.name = 'VCRFixtureNotFoundError'
    this.method = method
    this.fixturePath = fixturePath
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a VCR instance from environment variables.
 *   VCR_MODE=record|replay|auto
 *   VCR_DIR=tests/fixtures
 *
 * Defaults to replay mode (safe for CI).
 */
export function createVCRFromEnv(defaultFixtureDir = 'tests/fixtures/api'): VCR {
  const mode = (process.env.VCR_MODE ?? 'replay') as VCRMode
  const fixtureDir = process.env.VCR_DIR ?? defaultFixtureDir
  const strict = process.env.VCR_STRICT !== '0'

  return new VCR({ mode, fixtureDir, strict })
}

// ── Test Helper ─────────────────────────────────────────────────────────────

/**
 * Wrap a test to automatically set up VCR.
 *
 * Usage:
 *   it('does something', withVCR(async (vcr) => {
 *     const result = await vcr.intercept(client.chat.completions, 'create', params)
 *     expect(result.choices[0].message.content).toBe('hello')
 *   }))
 */
export function withVCR<T>(
  fn: (vcr: VCR) => Promise<T>,
  options: Partial<VCRConfig> = {},
): () => Promise<T> {
  return async () => {
    const vcr = createVCRFromEnv()
    // Apply overrides
    Object.assign(vcr, { config: { ...vcr, ...options } })
    return fn(vcr)
  }
}
