/**
 * SelectPicker + PermissionDialog component rendering tests.
 *
 * Keyboard interaction tests are omitted because ink-testing-library v4
 * does not fully simulate Ink v5's raw-mode useInput hook. Keyboard
 * handlers are simple enough to verify by inspection + manual testing.
 *
 * Rendering is verified via ink-testing-library's render() + lastFrame().
 */

import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import { SelectPicker, type SelectPickerItem } from '../components/SelectPicker.js'
import { PermissionDialog } from '../components/PermissionDialog.js'
import { MessageList } from '../components/MessageList.js'
import type { UIMessage } from '../store.js'

describe('SelectPicker rendering', () => {
  it('renders items with title and navigation hint', () => {
    const items: SelectPickerItem<string>[] = [
      { label: 'Option A', value: 'a' },
      { label: 'Option B', value: 'b' },
    ]
    const { lastFrame } = render(
      <SelectPicker items={items} title="Choose" onSelect={() => {}} onCancel={() => {}} />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Choose')
    expect(frame).toContain('Option A')
    expect(frame).toContain('Option B')
    expect(frame).toContain('navigate')
  })

  it('renders item descriptions', () => {
    const items: SelectPickerItem<string>[] = [
      { label: 'Session 1', description: '5 msgs', value: 's1' },
    ]
    const { lastFrame } = render(
      <SelectPicker items={items} title="Sessions" onSelect={() => {}} onCancel={() => {}} />,
    )
    expect((lastFrame() ?? '')).toContain('5 msgs')
  })

  it('renders empty state message', () => {
    const { lastFrame } = render(
      <SelectPicker items={[]} title="Empty" onSelect={() => {}} onCancel={() => {}} />,
    )
    expect((lastFrame() ?? '')).toContain('No items to choose from')
  })

  it('highlights first item by default', () => {
    const items: SelectPickerItem<string>[] = [
      { label: 'First', value: 'f' },
      { label: 'Second', value: 's' },
    ]
    const { lastFrame } = render(
      <SelectPicker items={items} title="Pick" onSelect={() => {}} onCancel={() => {}} />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('▸')
    expect(frame).toContain('First')
  })
})

describe('PermissionDialog rendering', () => {
  it('renders dangerous risk level in red', () => {
    const { lastFrame } = render(
      <PermissionDialog
        request={{ toolName: 'Bash', preview: 'rm -rf /', riskLevel: 'dangerous' }}
        onResolve={() => {}}
      />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Permission Request')
    expect(frame).toContain('Bash')
    expect(frame).toContain('DANGEROUS')
    expect(frame).toContain('rm -rf /')
  })

  it('renders needs-approval risk level', () => {
    const { lastFrame } = render(
      <PermissionDialog
        request={{ toolName: 'Write', preview: '/etc/passwd', riskLevel: 'needs-approval' }}
        onResolve={() => {}}
      />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('needs approval')
    expect(frame).toContain('Write')
  })

  it('renders safe risk level', () => {
    const { lastFrame } = render(
      <PermissionDialog
        request={{ toolName: 'Read', preview: 'file.txt', riskLevel: 'safe' }}
        onResolve={() => {}}
      />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('[safe]')
    expect(frame).not.toContain('DANGEROUS')
  })

  it('shows keyboard hints', () => {
    const { lastFrame } = render(
      <PermissionDialog
        request={{ toolName: 'Bash', preview: 'ls', riskLevel: 'safe' }}
        onResolve={() => {}}
      />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('[y]')
    expect(frame).toContain('[n]')
    expect(frame).toContain('[a]')
  })
})

describe('MessageList scrollback', () => {
  function makeMessages(n: number): UIMessage[] {
    return Array.from({ length: n }, (_, i): UIMessage => ({
      id: i,
      type: 'info',
      text: `msg-${String(i).padStart(3, '0')}`,
    }))
  }

  it('renders all messages when under the limit', () => {
    const { lastFrame } = render(<MessageList messages={makeMessages(10)} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('msg-000')
    expect(frame).toContain('msg-009')
    expect(frame).not.toContain('hidden')
  })

  it('truncates and shows indicator when over limit', () => {
    const msgs = makeMessages(60)
    const { lastFrame } = render(<MessageList messages={msgs} maxMessages={20} />)
    const frame = lastFrame() ?? ''
    // Should show the indicator
    expect(frame).toContain('hidden')
    expect(frame).toContain('showing last 20')
    // Should NOT show early messages
    expect(frame).not.toContain('msg-000')
    expect(frame).not.toContain('msg-039')
    // Should show recent messages
    expect(frame).toContain('msg-059')
  })

  it('default limit is 50', () => {
    const msgs = makeMessages(55)
    const { lastFrame } = render(<MessageList messages={msgs} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('hidden')
    expect(frame).toContain('5 earlier')
    // msg-004 is the first hidden one, msg-005 should be visible
    expect(frame).not.toContain('msg-004')
    expect(frame).toContain('msg-054')
  })
})

describe('MessageList tool collapsing', () => {
  function makeToolMsg(id: number, name: string, result?: string): UIMessage {
    return {
      id,
      type: 'tool',
      name,
      input: { file_path: `file${id}.ts` },
      result: result ?? `result ${id}`,
      isError: false,
    }
  }

  it('collapses 3+ consecutive Read calls into a summary', () => {
    const msgs: UIMessage[] = [
      makeToolMsg(1, 'Read'),
      makeToolMsg(2, 'Read'),
      makeToolMsg(3, 'Read'),
      makeToolMsg(4, 'Read'),
    ]
    const { lastFrame } = render(<MessageList messages={msgs} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('⤿')
    expect(frame).toContain('Read ×4')
    expect(frame).toContain('Ctrl+O')
  })

  it('does not collapse fewer than 3 consecutive reads', () => {
    const msgs: UIMessage[] = [
      makeToolMsg(1, 'Read'),
      makeToolMsg(2, 'Read'),
    ]
    const { lastFrame } = render(<MessageList messages={msgs} />)
    const frame = lastFrame() ?? ''
    expect(frame).not.toContain('⤿')
    expect(frame).toContain('result 1')
    expect(frame).toContain('result 2')
  })

  it('verbose mode shows all tool results expanded', () => {
    const msgs: UIMessage[] = [
      makeToolMsg(1, 'Read'),
      makeToolMsg(2, 'Read'),
      makeToolMsg(3, 'Read'),
    ]
    const { lastFrame } = render(<MessageList messages={msgs} verbose />)
    const frame = lastFrame() ?? ''
    expect(frame).not.toContain('⤿')
    expect(frame).toContain('result 1')
    expect(frame).toContain('result 3')
  })

  it('collapses mixed Read/Grep/Glob calls', () => {
    const msgs: UIMessage[] = [
      makeToolMsg(1, 'Read'),
      makeToolMsg(2, 'Grep'),
      makeToolMsg(3, 'Glob'),
    ]
    const { lastFrame } = render(<MessageList messages={msgs} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('⤿')
    expect(frame).toContain('Read/Grep/Glob ×3')
  })

  it('does not collapse non-collapsible tools (Bash, Write)', () => {
    const msgs: UIMessage[] = [
      makeToolMsg(1, 'Bash'),
      makeToolMsg(2, 'Bash'),
      makeToolMsg(3, 'Bash'),
    ]
    const { lastFrame } = render(<MessageList messages={msgs} />)
    const frame = lastFrame() ?? ''
    expect(frame).not.toContain('⤿')
    expect(frame).toContain('result 1')
    expect(frame).toContain('result 3')
  })
})
