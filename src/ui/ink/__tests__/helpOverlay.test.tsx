/**
 * HelpOverlay component rendering test.
 *
 * v0.4.1 C3 (Registry single-source): the slash-command group is rendered
 * from listCommands(), so this test registers the real builtins and asserts
 * against the SAME slice the component renders — no hardcoded command names.
 * (Pre-C3 it asserted '/model' and '/resume' without ever registering the
 * builtin commands: an empty-registry baseline failure.)
 */

import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import { HelpOverlay } from '../components/HelpOverlay.js'
import { listCommands } from '../../../commands/index.js'
import '../../../commands/builtin.js' // populate the registry the overlay reads

describe('HelpOverlay rendering', () => {
  it('renders title and shortcut groups', () => {
    const { lastFrame } = render(<HelpOverlay onDismiss={() => {}} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Keyboard Shortcuts')
    expect(frame).toContain('Input')
    expect(frame).toContain('Navigation')
    expect(frame).toContain('Slash Commands')
    expect(frame).toContain('Permissions')
  })

  it('includes key shortcuts and the registry-driven command slice', () => {
    const { lastFrame } = render(<HelpOverlay onDismiss={() => {}} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Enter')
    expect(frame).toContain('Ctrl+J')
    expect(frame).toContain('ESC')
    // The exact same source + slice the component renders (HelpOverlay
    // shows the first 12 registry commands, alphabetically):
    const topCmds = listCommands().slice(0, 12)
    expect(topCmds.length).toBeGreaterThan(0)
    for (const c of topCmds) {
      expect(frame).toContain('/' + c.name)
    }
  })

  it('shows dismiss hint', () => {
    const { lastFrame } = render(<HelpOverlay onDismiss={() => {}} />)
    expect((lastFrame() ?? '')).toContain('dismiss')
  })
})
