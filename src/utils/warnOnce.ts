/**
 * Process-wide warn-once facility.
 *
 * Config/state loaders that degrade to defaults on corrupt input must tell
 * the user WHY they got defaults — but exactly once per key, and only on
 * stderr. stdout is reserved for program output (--pipe contract: the answer
 * and nothing else), so a warning on stdout would corrupt machine-readable
 * pipe output.
 */

const seen = new Set<string>()

/**
 * Emit `message` to stderr the first time `key` is seen; subsequent calls
 * with the same key are no-ops. Returns true if the warning was emitted.
 */
export function warnOnce(key: string, message: string): boolean {
  if (seen.has(key)) return false
  seen.add(key)
  process.stderr.write(message.endsWith('\n') ? message : message + '\n')
  return true
}

/** Clear the dedup set. Test-only escape hatch. */
export function resetWarnOnce(): void {
  seen.clear()
}
