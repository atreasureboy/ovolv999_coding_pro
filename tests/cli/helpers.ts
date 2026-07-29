/**
 * Spawn harness for real-CLI end-to-end tests.
 *
 * Runs `node node_modules/tsx/dist/cli.mjs bin/ovogogogo.ts <args>` as a
 * child process with a fully isolated environment (tmp HOME/USERPROFILE,
 * caller-supplied OPENAI_*), capturing stdout/stderr separately. A 30s
 * watchdog kills runaway children so a hung boot fails the test instead
 * of the whole run.
 */
import { spawn } from 'child_process'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const tsxCli = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const binEntry = join(repoRoot, 'bin', 'ovogogogo.ts')

export interface CliRunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface CliRunOptions {
  /** Written to the child's stdin, then closed. `''` = empty piped stdin (non-TTY). */
  stdin?: string
  /** Merged over the scrubbed base env. */
  env?: Record<string, string>
  cwd?: string
  timeoutMs?: number
}

/** Env keys scrubbed from the child so host config can never leak into a test run. */
const SCRUB_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL',
  'OVOGO_CWD', 'OVOGO_MAX_ITER', 'OVOGO_MAX_CONTEXT_TOKENS', 'OVOGO_TEMPERATURE',
  'OVOGO_POOR', 'OVOGO_SHELL', 'OVOGO_LOOP_MAX_ITERS',
]

/**
 * Build an env with host provider credentials removed and HOME/USERPROFILE
 * pointed at a throwaway directory (so ~/.ovogo and ~/.claude are isolated).
 */
export function isolatedEnv(tmpHome: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !SCRUB_KEYS.includes(k)) env[k] = v
  }
  env.HOME = tmpHome
  env.USERPROFILE = tmpHome
  return { ...env, ...extra }
}

export function runCli(args: string[], opts: CliRunOptions = {}): Promise<CliRunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [tsxCli, binEntry, ...args], {
      cwd: opts.cwd ?? repoRoot,
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const watchdog = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, opts.timeoutMs ?? 30_000)
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', (err) => {
      clearTimeout(watchdog)
      stderr += `\nspawn error: ${err.message}`
      resolvePromise({ code: null, stdout, stderr, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(watchdog)
      resolvePromise({ code, stdout, stderr, timedOut })
    })
    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin)
    }
    child.stdin.end()
  })
}
