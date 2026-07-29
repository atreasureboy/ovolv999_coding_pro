import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setTerminalTitle } from '../../utils/terminalTitle.js'

describe('terminalTitle', () => {
  let spy: ReturnType<typeof vi.fn>
  let originalIsTTY: PropertyDescriptor | undefined

  beforeEach(() => {
    originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
    spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalIsTTY) Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
    else Reflect.deleteProperty(process.stdout, 'isTTY')
  })

  it('writes OSC escape sequence for title', () => {
    setTerminalTitle('test title')
    expect(spy).toHaveBeenCalledWith('\x1b]0;test title\x07')
  })

  it('handles special characters in title', () => {
    setTerminalTitle('ovolv999 · gpt-4o · working')
    const call = spy.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('gpt-4o'),
    )
    expect(call).toBeDefined()
  })
})
