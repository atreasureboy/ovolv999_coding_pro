/**
 * External editor integration — opens $EDITOR (or $VISUAL) with a temp file,
 * waits for the user to edit and exit, then returns the content.
 *
 * Used by Ctrl+G in the prompt input for composing long prompts in
 * vim/nano/emacs/code/etc.
 */

import { spawnSync } from 'child_process'
import { writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Open the user's preferred editor with optional initial content.
 * Returns the edited text, or null if the editor failed or was cancelled.
 *
 * The calling code is responsible for suspending/resuming Ink raw mode
 * around this call, e.g.:
 *
 *   const { stdin } = useStdin()
 *   stdin.setRawMode(false)
 *   const result = openInEditor(initialText)
 *   stdin.setRawMode(true)
 */
export function openInEditor(initialContent?: string): string | null {
  const editor = process.env.VISUAL || process.env.EDITOR || 'vi'

  // Create temp file
  const tmpDir = mkdtempSync(join(tmpdir(), 'ovolv999-edit-'))
  const tmpFile = join(tmpDir, 'prompt.md')

  try {
    writeFileSync(tmpFile, initialContent ?? '', 'utf-8')

    // Spawn editor synchronously — the calling code must have already
    // disabled raw mode so the editor can take over the terminal.
    const result = spawnSync(editor, [tmpFile], {
      stdio: 'inherit',
      env: process.env,
    })

    if (result.error || result.status !== 0) {
      return null
    }

    if (!existsSync(tmpFile)) return null

    const content = readFileSync(tmpFile, 'utf-8')
    return content.trim() || null
  } catch {
    return null
  } finally {
    try {
      // rmSync, not unlinkSync: unlink throws EISDIR on the directory and
      // the best-effort catch swallowed it, leaking a temp dir per use.
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup
    }
  }
}
