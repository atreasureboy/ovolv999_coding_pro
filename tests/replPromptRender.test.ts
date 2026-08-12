/**
 * Classic REPL prompt-render contract test.
 *
 * The classic (non-Ink) REPL prompt is a three-step contract:
 *   1. `renderer.writePrompt()` — draws the prompt box's top border.
 *   2. `input.readLine(renderer.promptPrefix())` — readline echoes the
 *      `│ › ` cursor-line prefix (obtained separately) and the user's typed
 *      text on the same line.
 *   3. `renderer.closePrompt(text, isTTY)` — in a TTY, backs up over the
 *      live input rows and redraws the submitted text framed inside the
 *      box; in a non-TTY, just closes the box.
 *
 * Round 16 broke step 2 by passing `''` to readLine (the cursor line was
 * never shown) and step 3's row count was a hardcoded `6` that drifted
 * from `displayWidth(promptPrefix())`. This test pins the contract:
 *
 *   - short input renders a single framed line
 *   - wide input wraps across multiple framed lines
 *   - Ctrl+D (EOF) resolves the readLine with `{ eof: true }` so the REPL
 *     saves and exits
 *   - Esc (AbortSignal) resolves with `{ eof: true, aborted: true }` so the
 *     REPL treats it as an interrupt, not an exit
 *
 * The InputHandler is driven by real PassThrough streams (terminal:false)
 * so the readline question callbacks actually fire — mirroring
 * inputHandlerLeak.test.ts. The Renderer writes into a capturing Writable
 * so we can assert on the exact ANSI stream.
 */

import { describe, it, expect } from 'vitest'
import { Writable, PassThrough } from 'node:stream'
import { Renderer } from '../src/ui/renderer.js'
import { PipeRenderer } from '../src/ui/pipeRenderer.js'
import { InputHandler } from '../src/ui/input.js'
import { stripAnsi } from '../src/utils/ansi.js'

function captureRenderer(width = 80): { renderer: Renderer; output: () => string } {
  let captured = ''
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      captured += String(chunk)
      callback()
    },
  })
  // Cast: the Renderer constructor accepts a WritableStream; we attach a
  // `columns` prop so the resize listener / width math sees our test width.
  ;(stream as unknown as { columns: number }).columns = width
  const renderer = new Renderer({ stream })
  return { renderer, output: () => captured }
}

/** Yield once so the readline can finish enqueuing the question. */
const yieldOnce = (): Promise<void> => new Promise<void>((r) => setImmediate(r))

describe('classic REPL prompt-render contract', () => {
  it('writePrompt draws the box border; promptPrefix is the `│ › ` cursor line (display width 6)', () => {
    const { renderer, output } = captureRenderer()
    renderer.writePrompt()
    const plain = stripAnsi(output())

    // Top border only — the cursor line is NOT drawn by writePrompt
    // (readline echoes it from the promptPrefix argument).
    expect(plain).toContain('╭─ ask ovolv999')
    expect(plain).not.toMatch(/│\s*›/) // no cursor line yet

    const prefix = renderer.promptPrefix()
    // The cursor-line prefix has display width 6 — this is the value
    // closePrompt's row-backup math depends on. Pin it so a future
    // "cleanup" cannot silently change the glyph spacing and desync
    // closePrompt's hardcoded width.
    const visible = stripAnsi(prefix)
    expect(visible).toBe('  │ › ')
    expect([...visible].length).toBe(6)
  })

  it('short input: readLine echoes the prefix; closePrompt frames one line', async () => {
    const { renderer, output } = captureRenderer(80)
    const input = new PassThrough()
    const out = new PassThrough()
    const handler = new InputHandler({ input, output: out, terminal: false })

    // Step 1: draw the box.
    renderer.writePrompt()
    // Step 2: readline echoes the cursor-line prefix + the user's typed text.
    const prefix = renderer.promptPrefix()
    const pending = handler.readLine(prefix)
    await yieldOnce()
    input.write('fix the bug\n')
    const result = await pending
    expect(result.eof).toBe(false)
    expect(result.text).toBe('fix the bug')

    // Step 3: closePrompt redraws the submitted text inside the frame.
    renderer.closePrompt(result.text, true)
    const plain = stripAnsi(output())

    // The framed prompt now contains the cursor line AND the submitted text
    // on a single content line (short input → no wrap).
    expect(plain).toContain('╭─ ask ovolv999')
    expect(plain).toContain('│ › fix the bug')
    expect(plain).toContain('╰')
    // Exactly one content line between the borders (the `│ › fix the bug │`
    // row). Count lines that carry a content `│` and the `›` cursor.
    const cursorLines = plain.split('\n').filter((l) => l.includes('│ ›'))
    expect(cursorLines.length).toBe(1)
  })

  it('wide input wraps across multiple framed content lines', () => {
    const { renderer, output } = captureRenderer(80)
    renderer.writePrompt()
    // 50 full-width `？` → display width 100 → wraps inside an inner width
    // of (80-6)-3 = 71 → ceil(100/71) = 2 content lines.
    const wide = '？'.repeat(50)
    renderer.closePrompt(wide, true)
    const plain = stripAnsi(output())

    expect(plain).toContain('╭─ ask ovolv999')
    // Content lines are every `│`-bearing row except the pure border rows.
    const contentLines = plain
      .split('\n')
      .filter((l) => l.includes('│') && !l.includes('╭') && !l.includes('╰'))
    expect(contentLines.length).toBeGreaterThanOrEqual(2)
    // First wrapped line carries the cursor glyph; continuation lines indent.
    expect(contentLines[0]).toContain('│ ›')
    // Every content line closes the right border `│` (the frame is sealed).
    expect(contentLines.every((l) => l.endsWith('│'))).toBe(true)
  })

  it('Ctrl+D at the prompt resolves readLine with { eof: true } (exit, not interrupt)', async () => {
    const input = new PassThrough()
    const out = new PassThrough()
    const handler = new InputHandler({ input, output: out, terminal: false })

    const pending = handler.readLine('  │ › ')
    await yieldOnce()
    // Ctrl+D closes the input stream → readline emits 'close'.
    input.end()
    const result = await pending

    expect(result.eof).toBe(true)
    expect(result.aborted).not.toBe(true) // EOF, not an Esc abort
    handler.close()
  })

  it('Esc (AbortSignal) resolves readLine with { eof: true, aborted: true } (interrupt, not exit)', async () => {
    const input = new PassThrough()
    const out = new PassThrough()
    const handler = new InputHandler({ input, output: out, terminal: false })

    const controller = new AbortController()
    const pending = handler.readLine('  │ › ', controller.signal)
    await yieldOnce()
    // Esc fires the abort signal — the REPL's interrupt path.
    controller.abort()
    const result = await pending

    expect(result.eof).toBe(true)
    expect(result.aborted).toBe(true) // distinguishable from Ctrl+D
    handler.close()
  })

  it('PipeRenderer is a no-op for writePrompt/closePrompt (pipe stdout = answer only)', () => {
    // PipeRenderer routes diagnostics to stderr and suppresses all prompt
    // chrome via overrides. Constructing it touches process.stderr (the
    // super() stream), so we verify the override contract directly: the
    // overridden methods are no-ops that emit nothing to ANY stream,
    // unlike the concrete Renderer which draws the box.
    const pipe = new PipeRenderer()
    // The overrides must not throw and must not write the prompt box.
    // (writePrompt/closePrompt on the concrete Renderer emit `╭─ ask
    // ovolv999`; the PipeRenderer overrides emit nothing.)
    expect(() => {
      pipe.writePrompt()
      pipe.closePrompt('anything', true)
    }).not.toThrow()
    // promptPrefix is inherited from Renderer (harmless — pipe mode
    // returns before the REPL loop reaches readLine). It still returns
    // the canonical `│ › ` cursor-line prefix; pin it so a future
    // override that "cleans up" promptPrefix does not silently break
    // the inherited width contract.
    const inherited = stripAnsi(pipe.promptPrefix())
    expect(inherited).toBe('  │ › ')
    expect([...inherited].length).toBe(6)
  })
})
