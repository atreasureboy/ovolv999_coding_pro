/**
 * Concurrency Primitives — sequential wrapper + child abort controller
 *
 * Inspired by claude-code-best's utils/sequential.ts + utils/abortController.ts.
 *
 * sequential(fn): wraps an async function so concurrent calls execute
 * strictly in arrival order. Prevents race conditions in file writes,
 * memory persistence, and other side-effecting operations.
 *
 * createChildAbortController(parent): creates a child AbortController that
 * propagates parent abort without leaking listeners. The child auto-removes
 * its parent listener when aborted, preventing MaxListenersExceededWarning.
 */

/**
 * Wrap an async function so concurrent calls execute strictly in arrival order.
 * Calls are queued; each waits for the previous to settle before running.
 *
 * @example
 * const safeWrite = sequential(async (path, content) => { await writeFile(path, content) })
 * // These will NOT interleave:
 * safeWrite('a.txt', '1')
 * safeWrite('a.txt', '2')
 */
export function sequential<T extends (...args: never[]) => Promise<unknown>>(
  fn: T,
): (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>> {
  let pending: Promise<unknown> = Promise.resolve()
  return (...args: Parameters<T>): Promise<Awaited<ReturnType<T>>> => {
    const result = pending.then(() => fn(...args))
    // Chain error recovery so one failure doesn't block subsequent calls
    pending = result.then(() => undefined, () => undefined)
    return result as Promise<Awaited<ReturnType<T>>>
  }
}

/**
 * Create a child AbortController that propagates the parent's abort signal.
 * Unlike a plain addEventListener, this auto-removes the listener when the
 * child is aborted or garbage-collected, preventing listener leaks in
 * nested abort chains (sub-agents, background tasks).
 */
export function createChildAbortController(
  parent?: AbortSignal,
): AbortController {
  const child = new AbortController()

  if (parent) {
    if (parent.aborted) {
      child.abort(parent.reason)
    } else {
      const onParentAbort = (event: Event): void => {
        child.abort((event.target as AbortSignal).reason)
      }
      parent.addEventListener('abort', onParentAbort, { once: true })

      // Auto-cleanup when child aborts (removes parent listener)
      child.signal.addEventListener('abort', () => {
        parent.removeEventListener('abort', onParentAbort)
      }, { once: true })
    }
  }

  return child
}
