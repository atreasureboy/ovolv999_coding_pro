/**
 * Atomic file write helper — write to a temp file in the same directory and
 * rename over the target. The rename is atomic on POSIX, so a crash mid-write
 * can never leave a half-written file at the target path.
 *
 * Used by tools that need crash-safety (FileWriteTool, FileEditTool). The
 * existing session persistence in src/core/sessionManager.ts already uses the
 * same pattern; this helper centralizes the convention so all file mutations
 * share one well-tested implementation.
 *
 * Durability:
 *   - The tmp file is fsync'd (`handle.sync()`) BEFORE rename. Without
 *     this, a power loss / kernel panic between rename and the kernel's
 *     background flush of the tmp's data could leave a zero-byte inode
 *     at the target path after recovery. fsync forces the data + metadata
 *     to stable storage so the rename publishes committed bytes.
 *   - We do NOT fsync the parent directory. Full POSIX durability would
 *     require that too (so the directory entry survives a crash), but
 *     that's an OS-level operation with poor cross-platform support and
 *     significant latency cost. Most editors / build tools don't bother.
 *     If you need that guarantee, call fsync on the parent yourself.
 *
 * Mode preservation:
 *   - If the target already exists, the temp file is chmod'd to MATCH the
 *     target's mode before the rename. This prevents losing the executable
 *     bit (0755) when a tool overwrites a script.
 *   - If the target is new, the temp file is created with the process umask
 *     applied — typically 0644 for regular files. Callers that need a
 *     specific mode for new files should chmod the target explicitly.
 *
 * Symlink behavior (write-through semantics):
 *   - When `target` IS a symlink that resolves to an existing file, we
 *     follow it: the atomic write happens on the symlink's REAL target
 *     (via `fs.realpath`). The symlink itself is preserved — exactly the
 *     semantics of `fs.writeFile` and any normal editor.
 *   - When `target` is a symlink to a directory, we throw a clear error
 *     rather than write through into the directory (atomicWrite writes
 *     FILES, not directory contents).
 *   - When `target` is a broken symlink (its realpath doesn't exist), we
 *     throw a clear error and DO NOT delete or modify the symlink. The
 *     user can fix the link and retry.
 *   - These cases are all detected up-front via `fs.lstat` + `fs.realpath`
 *     + `fs.stat`, BEFORE any temp file is created. A failure leaves no
 *     `.tmp.*` leftover.
 *   - Tmp files are placed in the same directory as the REAL target
 *     (not the symlink's directory) so the rename is atomic. This
 *     requires the symlink and its pointee to be on the same filesystem;
 *     crossing filesystems via symlink is rare in practice.
 *
 * Failure modes:
 *   - open / writeFile / sync fails      → fd closed, tmp unlinked, error rethrown
 *   - chmod fails                         → tmp unlinked, error rethrown
 *   - rename fails (cross-device move, perm) → tmp unlinked, error rethrown
 *   - mkdir fails (EACCES on parent)      → no tmp created, error rethrown
 *   - target is broken symlink or symlink→dir → clear error, no side effects
 *   - EEXIST collisions on the tmp name are avoided by using a
 *     process-unique suffix (pid + monotonic counter + random bytes).
 *
 * Caller MUST own the destination file content — if a crashed write has left
 * an old tmp file at the same name, we overwrite (writeFile truncates). The
 * rename step will then succeed atomically. We never touch the target until
 * the tmp is fully written and fsync'd.
 */

import { rename, unlink, stat, mkdir, lstat, realpath, open } from 'fs/promises'
import type { FileHandle } from 'fs/promises'
import { dirname } from 'path'
import { randomBytes } from 'crypto'

export interface AtomicWriteOptions {
  /** Encoding for the file. Default 'utf8'. */
  encoding?: BufferEncoding
}

/**
 * Monotonic counter for tmp file suffixes within this process. Combined with
 * pid + random bytes it makes collisions effectively impossible even when
 * many writes fire in the same millisecond from the same process.
 */
let _tmpCounter = 0

/**
 * Atomically replace the contents of `target` with `content`. The file is
 * either fully written or untouched — never half-written. If the target
 * doesn't exist yet it's created (along with its parent directories).
 *
 * For an EXISTING target, the temp file is chmod'd to match the target's
 * mode before the rename, so permissions like 0755 (executable scripts) are
 * not silently downgraded to 0644 by the writeFile default.
 *
 * Symlinks are followed (write-through): a write to `/link` where
 * `/link → /elsewhere/foo` updates `/elsewhere/foo` and leaves the symlink
 * in place. This matches `fs.writeFile` and editor behavior.
 *
 * Throws whatever the underlying syscall fails with. The tmp file is
 * cleaned up before rethrowing — callers can rely on no `.tmp.*` leftovers
 * being left behind by this function, regardless of which step failed.
 */
export async function atomicWrite(
  target: string,
  content: string,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const encoding = opts.encoding ?? 'utf8'

  // Resolve symlinks up front. For a symlink target we write to the
  // REAL path so the symlink is preserved (write-through semantics).
  let realTarget = target

  // Step 1: probe lstat(target). If target doesn't exist at all, fall
  // through to the "create new file" path. If target IS a symlink, we
  // commit to following it — any failure in the symlink chain surfaces
  // a clear error WITHOUT falling back to "create at the original path"
  // (which would silently delete the symlink).
  let isSymlink = false
  try {
    const lst = await lstat(target)
    if (lst.isSymbolicLink()) isSymlink = true
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    // Not a symlink and doesn't exist — fall through, realTarget = target.
  }

  // Step 2: if it's a symlink, resolve the chain. ANY failure here is a
  // broken-symlink condition — the link points nowhere usable.
  if (isSymlink) {
    try {
      realTarget = await realpath(target)
    } catch (err: unknown) {
      // realpath failed: broken symlink (target missing or unreadable
      // mid-chain) or ELOOP. Either way the symlink is unusable. Attach
      // the original error as `cause` so the underlying syscall detail
      // (ENOENT, ELOOP, EACCES) isn't lost when we rethrow.
      throw new Error(
        `atomicWrite: target ${target} is a broken symlink ` +
          `(cannot resolve: ${(err as Error).message}); ` +
          `fix the link before writing`,
        { cause: err },
      )
    }

    // Step 3: the resolved path must point to a regular file (existing or
    // creatable). Reject symlinks-to-directories outright — atomicWrite
    // writes FILES, not directory contents.
    try {
      const rs = await stat(realTarget)
      if (rs.isDirectory()) {
        throw new Error(
          `atomicWrite: target ${target} is a symlink to a directory ` +
            `(${realTarget}); refusing to write through`,
        )
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        // realpath succeeded (returned a string) but the final target
        // doesn't exist — a broken link where realpath was lenient.
        // (Linux realpath(3) returns the path even if the last component
        // is missing; Node mirrors that.) Attach cause for diagnostics.
        throw new Error(
          `atomicWrite: target ${target} is a broken symlink ` +
            `(points to ${realTarget} which does not exist); ` +
            `fix the link before writing`,
          { cause: err },
        )
      }
      throw err
    }
  }

  // Ensure parent dir of the REAL path exists. Following symlinks here
  // matches normal mkdir behavior — /link/sub where /link → /elsewhere
  // creates /elsewhere/sub if missing.
  await mkdir(dirname(realTarget), { recursive: true })

  // Capture mode from REAL target (stat follows symlinks; by this point
  // we know realTarget is either target itself or a resolved non-dir file).
  let existingMode: number | undefined
  try {
    const s = await stat(realTarget)
    existingMode = s.mode
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    // ENOENT — target doesn't exist. existingMode stays undefined; the
    // default (typically 0644 minus umask) is the right answer here.
  }

  // Uniquely-suffixed tmp file in the SAME directory as the REAL target so
  // the final rename is atomic (cross-device rename isn't). Suffix combines:
  //   - process pid  — distinguishes processes on the same system
  //   - monotonic counter — distinguishes same-process same-ms writes
  //   - Date.now() ms — distinguishes writes across processes
  //   - 6 random bytes hex — distinguishes concurrent writes from any source
  const counter = (_tmpCounter = (_tmpCounter + 1) | 0)
  const tmpPath = `${realTarget}.tmp.${process.pid}.${Date.now()}.${counter}.${randomBytes(6).toString('hex')}`

  // Open tmp file → write content → chmod (on the open fd) → fsync → close.
  // The fsync is the durability guarantee: without it, a power loss
  // between rename and the kernel's async flush could publish a zero-
  // byte inode at the target path after recovery.
  //
  // Why chmod uses the fd (FileHandle.chmod) and runs BEFORE sync, not
  // after close:
  //   - chmod-via-path resolves the file by path again. Its mode is a
  //     SEPARATE inode field than the one fsync flushed. A crash between
  //     sync and chmod would commit content bytes but leave the umask-
  //     default (typically 0644) mode on disk — silently downgrading an
  //     executable script to non-executable.
  //   - fd-based chmod (uv_fs_fchmod under the hood) updates the SAME
  //     in-memory inode state that the pending fsync is going to flush.
  //     A single sync() then publishes content AND the mode metadata
  //     atomically — so the rename publishes committed bytes WITH the
  //     right permissions, and a power-cut recovery can never observe
  //     a file with the wrong mode.
  let fh: FileHandle | null = null
  try {
    fh = await open(tmpPath, 'w')
    await fh.writeFile(content, encoding)
    if (existingMode !== undefined) {
      // fd-based chmod — applied to the same inode queued for fsync.
      await fh.chmod(existingMode)
    }
    await fh.sync()
    await fh.close()
    fh = null
    await rename(tmpPath, realTarget)
  } catch (err) {
    // Single cleanup point for ALL failure modes above (open, writeFile,
    // sync, close, chmod, rename). The `finally` guarantees the fd is
    // released even on a throw between open and close — without that,
    // a sync() failure would leak the descriptor until GC.
    if (fh) {
      try {
        await fh.close()
      } catch {
        /* fd may already be invalid; original error is more informative */
      }
    }
    try {
      await unlink(tmpPath)
    } catch {
      /* original error is more informative than a cleanup failure */
    }
    throw err
  }
}

/**
 * Read the file's mtime (ms) and size atomically. Used by Edit/Write to
 * detect that an external writer touched the file between our read and our
 * write — the canonical TOCTOU guard for read-modify-write loops.
 *
 * Returns null if the file does not exist (ENOENT) — caller decides how to
 * treat "file vanished".
 *
 * Symlink note: this follows symlinks — `lstat` would be needed to detect
 * a symlink-vs-regular swap. We accept that limitation: a swap from regular
 * → symlink is exceedingly rare and the caller has already validated the
 * path. For write-path consistency, atomicWrite resolves symlinks via
 * realpath before writing; this helper just reports the visible metadata.
 */
export async function statSafely(filePath: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const s = await stat(filePath)
    return { mtimeMs: s.mtimeMs, size: s.size }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}
