/**
 * Test helper: a no-op Renderer that swallows all calls.
 *
 * Tests that don't care about UI chrome should use this so the
 * engine can run end-to-end without a TTY. We use a Proxy so every
 * method (now and future) is auto-handled — no need to keep a
 * manual stub list in sync with the Renderer interface.
 */
import type { Renderer } from '../../src/ui/renderer.js'

export const silentRenderer = new Proxy({} as Renderer, {
  get(_target, prop) {
    if (prop === 'then') return undefined
    return () => {}
  },
})