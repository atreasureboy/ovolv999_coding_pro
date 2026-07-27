import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { SlashMenu, type SlashEntry } from '../components/SlashMenu.js'

const entries: SlashEntry[] = Array.from({ length: 12 }, (_, index) => ({
  name: `action-${index + 1}`,
  description: `Command ${index + 1}`,
  kind: 'cmd',
}))

describe('SlashMenu', () => {
  it('shows a bounded suggestion window instead of flooding the terminal', () => {
    const { lastFrame } = render(<SlashMenu entries={entries} selected={0} maxVisible={5} />)
    const frame = lastFrame() ?? ''

    expect(frame).toContain('/action-1')
    expect(frame).toContain('/action-5')
    expect(frame).not.toContain('/action-6')
    expect(frame).toContain('1/12')
    expect(frame).toContain('/? shows all')
  })

  it('moves the visible window with keyboard selection', () => {
    const { lastFrame } = render(<SlashMenu entries={entries} selected={9} maxVisible={5} />)
    const frame = lastFrame() ?? ''

    expect(frame).toContain('/action-10')
    expect(frame).not.toContain('/action-1 ')
    expect(frame).toContain('10/12')
  })
})
