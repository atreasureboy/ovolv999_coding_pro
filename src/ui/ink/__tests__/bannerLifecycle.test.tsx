import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { App, safeTerminalWidth } from '../App.js'
import { UIStore } from '../store.js'

function count(value: string, needle: string): number {
  return value.split(needle).length - 1
}

describe('banner lifecycle', () => {
  it('keeps dynamic rendering inside the terminal wrap boundary', () => {
    expect(safeTerminalWidth(120)).toBe(119)
    expect(safeTerminalWidth(undefined)).toBe(79)
  })

  it('keeps exactly one visible banner across conversation updates', async () => {
    const store = new UIStore()
    store.setBanner('0.3.5', 'MiniMax-M3')
    const view = render(
      <App
        store={store}
        _version="0.3.5"
        model="MiniMax-M3"
        skills={[]}
        runTurn={(_prompt, history) => Promise.resolve({ newHistory: history, reason: 'stop_sequence' })}
        dispatchSlash={() => Promise.resolve(true)}
        initialHistory={[]}
        maxContextTokens={200000}
        cwd="/project/demo"
      />,
    )

    store.addUserMessage('first')
    store.addAssistantMessage('reply one')
    store.addUserMessage('second')
    store.addAssistantMessage('reply two')
    await new Promise(resolve => setImmediate(resolve))

    const frame = view.lastFrame() ?? ''
    expect(count(frame, 'OVOLV999 / v0.3.5')).toBe(1)
    expect(frame).toContain('reply one')
    expect(frame).toContain('reply two')
    view.unmount()
  })
})
