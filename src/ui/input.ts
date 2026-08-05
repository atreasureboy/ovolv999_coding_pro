/**
 * Interactive input handler — raw readline with history support
 *
 * Provides ovogogogo-style input:
 * - ❯ prompt glyph
 * - Arrow key history navigation
 * - Ctrl+C to cancel / Ctrl+D to exit
 * - Multi-line paste support
 *
 * OWNERSHIP: There must be exactly one InputHandler per interactive
 * session. The REPL, AskUserQuestion, and ExitPlanMode all share THIS
 * readline. Creating a second `readline.createInterface` on the same
 * stdin corrupts input — the second interface races with the first for
 * keystrokes, leading to dropped prompts and intermingled output.
 *
 * External callers (askUser, exitPlanMode) receive a `SharedPrompt`
 * closure bound to this InputHandler's readline and use it instead of
 * creating their own.
 */

import { createInterface, type Interface } from 'readline'

const supportsSignalOption = parseInt((process.versions.node ?? '0').split('.')[0] ?? '0', 10) >= 22

export interface InputResult {
  text: string
  eof: boolean
  /** True if the read was cancelled by an AbortSignal (not Ctrl+D). */
  aborted?: boolean
}

/**
 * The shape a tool-side prompt (askUser, exitPlanMode) needs.
 * Returned by InputHandler.sharedPrompt() so callers can drive the
 * REPL's readline without instantiating a new one.
 */
export interface SharedPrompt {
  /** True iff the underlying IO is a TTY (controls auto-approve / EOF semantics). */
  readonly isTTY: boolean
  /**
   * Read a single line from the REPL's readline.
   * The caller is responsible for writing the prompt label / options
   * before invoking this. Returns `{ eof: true }` on Ctrl+D.
   *
   * @param signal Optional AbortSignal — when aborted, Node 24's
   *   `rl.question(query, { signal }, cb)` cancels the in-flight
   *   question internally (the readline is NOT closed). We listen
   *   for the abort event separately and settle the outer Promise
   *   with `{ eof: true, aborted: true }`. The same `rl` remains
   *   alive for the next readLine.
   */
  readLine(promptText: string, signal?: AbortSignal): Promise<InputResult>
  /** Close the underlying readline. Idempotent. */
  close(): void
}

export interface InputHandlerOptions {
  /** Input stream (defaults to process.stdin). */
  input?: NodeJS.ReadableStream
  /** Output stream (defaults to process.stdout). */
  output?: NodeJS.WritableStream
  /** Whether the stream pair is a TTY (defaults to process.stdout.isTTY). */
  terminal?: boolean
  /** readline history size. */
  historySize?: number
  /**
   * Readline Tab completer. Called by readline when the user hits Tab; the
   * returned `[matches, originalLine]` pair drives readline's in-line
   * completion overlay. Pass `undefined` to disable Tab completion (default).
   */
  completer?: (line: string) => [string[], string]
}

export class InputHandler {
  private rl: Interface
  private readonly streams: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream; terminal: boolean }
  private readonly historySize: number
  private history: string[] = []
  private closed = false

  /**
   * @param opts Optional stream / TTY overrides. Production callers
   *   pass nothing and get stdin/stdout. Tests pass PassThrough
   *   streams so they can drive the readline deterministically and
   *   assert `listenerCount('close')` between calls.
   *
   * The streams are stored so the readline can be (re)constructed
   * with the same configuration; the live `rl` is always read
   * directly via `this.rl`.
   */
  constructor(opts: InputHandlerOptions = {}) {
    this.streams = {
      input: opts.input ?? process.stdin,
      output: opts.output ?? process.stdout,
      terminal: opts.terminal ?? (opts.input ? false : process.stdout.isTTY),
    }
    this.historySize = opts.historySize ?? 100
    this.rl = createInterface({
      input: this.streams.input,
      output: this.streams.output,
      terminal: this.streams.terminal,
      historySize: this.historySize,
      // Tab completer is opt-in. When unset, readline falls back to the
      // built-in default (path completion). SlashSuggest.complete is the
      // production completer wired in bin/ovogogogo.ts runRepl.
      completer: opts.completer,
    })
    // Prevent readline from closing on Ctrl+C (SIGINT).
    // Without this handler readline emits 'close', which kills the REPL.
    // Our SIGINT handler in the main entry point handles Ctrl+C instead.
    this.rl.on('SIGINT', () => {})
  }

  /** Exposed for tests that need to inspect the underlying readline. */
  get readline(): Interface { return this.rl }

  /** Current line in the readline buffer (empty before/after readLine resolves). */
  getLine(): string { return this.rl.line }

  /** Underlying output stream — used by live overlays (e.g. slash suggester). */
  get output(): NodeJS.WritableStream { return this.streams.output }

  /** TTY mode flag — slash suggester is auto-disabled when false. */
  get isTTY(): boolean { return this.streams.terminal }

  /**
   * Read a line via the REPL's owned readline.
   * All interactive prompts in this CLI MUST go through this method
   * (or a SharedPrompt returned by sharedPrompt()) — never create a
   * second readline.
   *
   * Cancellation: Node 24's `rl.question(query, { signal }, cb)`
   * accepts an AbortSignal. When the signal aborts, Node cancels the
   * pending question internally (the callback is NOT invoked and the
   * readline is NOT closed) — the underlying prompt is silently
   * discarded. We listen for the abort event on the signal ourselves
   * to settle the outer Promise with `{ eof: true, aborted: true }`.
   *
   * Listener leak: `settleOnce` removes both the close listener (for
   * the Ctrl+D path) and the abort listener (for the signal-abort
   * path) so neither lingers into the next readLine. `once` would
   * auto-remove on fire, but the question-callback path settles
   * BEFORE close fires — so we always remove explicitly.
   *
   * The same `rl` is used across calls. Aborting one readLine does
   * NOT close the interface, so the next readLine works against the
   * same readline bound to the same streams.
   */
  readLine(promptText: string, signal?: AbortSignal): Promise<InputResult> {
    if (this.closed) {
      return Promise.resolve({ text: '', eof: true })
    }
    if (signal?.aborted) {
      // Already aborted before we even started — resolve immediately.
      return Promise.resolve({ text: '', eof: true, aborted: true })
    }
    const rl = this.rl
    return new Promise<InputResult>((resolve) => {
      let settled = false
      const settleOnce = (result: InputResult): void => {
        if (settled) return
        settled = true
        rl.removeListener('close', onClose)
        signal?.removeEventListener('abort', onAbort)
        resolve(result)
      }
      // Named handlers — settleOnce references them, so they must
      // be declared before being registered.
      const onClose = (): void => settleOnce({ text: '', eof: true })
      const onAbort = (): void => settleOnce({ text: '', eof: true, aborted: true })

      // Register BOTH listeners BEFORE calling rl.question so we
      // never miss an abort that fires during the question setup.
      rl.once('close', onClose)
      if (signal) signal.addEventListener('abort', onAbort, { once: true })

      try {
        // Native signal option: Node 24 cancels the pending question
        // internally on abort. The callback is not invoked, the
        // readline is not closed. Our onAbort handler settles the
        // outer Promise.
        if (signal && supportsSignalOption) {
          rl.question(promptText, { signal }, (answer) => {
            if (answer.trim()) {
              this.history.unshift(answer)
            }
            settleOnce({ text: answer, eof: false })
          })
        } else {
          rl.question(promptText, (answer) => {
            if (answer.trim()) {
              this.history.unshift(answer)
            }
            settleOnce({ text: answer, eof: false })
          })
        }
      } catch {
        settleOnce({ text: '', eof: true })
      }
    })
  }

  /**
   * Hand a SharedPrompt to a non-REPL caller (AskUserQuestion,
   * ExitPlanMode). The returned object shares THIS readline — no second
   * readline interface is created.
   */
  sharedPrompt(): SharedPrompt {
    return {
      // Use the constructed readline's terminal flag, not the global
      // process.stdout.isTTY — the readline was constructed with a
      // specific terminal setting and the rest of the handler respects
      // that. Tests that pass { input: PassThrough } get
      // isTTY=false, which the askUser handler maps to its
      // non-interactive fallback path.
      isTTY: this.streams.terminal,
      readLine: (p, signal) => this.readLine(p, signal),
      close: () => this.close(),
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.rl.close()
    } catch {
      /* already closed */
    }
  }
}

/**
 * Read a single line from stdin (for pipe/non-TTY usage).
 *
 * The previous implementation used a 10-second timeout as a "generous
 * limit for slow pipes" — but that was a *hard* cap that truncated any
 * legitimate slow producer (CI logs, large fixtures, `git log | ovogo`).
 * The fix: use a much longer safety net (30 min) AND let callers opt out
 * of the timeout entirely via `readStdin({ timeoutMs: 0 })`.
 */
export interface ReadStdinOptions {
  /**
   * Max time to wait for stdin to close (ms). `0` disables the timeout —
   * readStdin will block until EOF, a 'close' event, or a 'data' error.
   * Default: 30 minutes (1_800_000 ms). Long enough for realistic slow
   * pipes; short enough that a real stdin hang still surfaces.
   */
  timeoutMs?: number
}

export async function readStdin(opts: ReadStdinOptions = {}): Promise<string> {
  if (process.stdin.isTTY) return ''
  const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let timer: ReturnType<typeof setTimeout> | null = null
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      process.stdin.removeListener('data', onData)
      process.stdin.removeListener('end', onEnd)
      process.stdin.removeListener('error', onError)
      process.stdin.removeListener('close', onEnd)
      resolve(Buffer.concat(chunks).toString('utf8').trim())
    }
    const onData = (chunk: Buffer): void => { chunks.push(chunk) }
    const onEnd = (): void => done()
    const onError = (): void => done()

    process.stdin.on('data', onData)
    process.stdin.on('end', onEnd)
    process.stdin.on('error', onError)
    process.stdin.on('close', onEnd)

    if (timeoutMs > 0) {
      timer = setTimeout(done, timeoutMs)
    }
  })
}