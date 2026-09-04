/**
 * Canonical POSIX shell quoting for execSync/execFileSync shell-string
 * interpolation (sandbox prefixes, git sync, ssh/rsync command assembly).
 *
 * keychain.ts deliberately does NOT use this: `security -i` consumes a
 * private line protocol with its own tokenizer, not a POSIX shell — see
 * the comment beside its local quoter.
 */
export function shellQuote(s: string): string {
  if (s === '') return "''"
  if (/^[A-Za-z0-9_:.@/=-]+$/.test(s)) return s
  return `'${s.replace(/'/g, "'\\''")}'`
}
