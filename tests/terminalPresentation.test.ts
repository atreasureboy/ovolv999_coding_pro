import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { Renderer } from '../src/ui/renderer.js'
import { stripAnsi } from '../src/utils/ansi.js'

describe('terminal presentation', () => {
  it('renders a compact product header and structured metadata', () => {
    let output = ''
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk)
        callback()
      },
    })
    const renderer = new Renderer({ stream })
    renderer.banner('0.3.5', 'MiniMax-M3')
    renderer.info('workspace   /project/demo')
    const plain = stripAnsi(output)

    expect(plain).toContain('◆ OVOLV999')
    expect(plain).toContain('v0.3.5')
    expect(plain).toContain('MiniMax-M3  ● ONLINE')
    expect(plain).toContain('AUTONOMOUS CODING RUNTIME')
    expect(plain).toContain('◇ WORKSPACE  /project/demo')
    expect(plain).not.toContain('Think-Act-Observe')
  })
})
