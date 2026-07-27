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
    renderer.info('git         main · clean')
    renderer.info('memory      ready')
    renderer.info('session     new')
    renderer.info('ready       /help')
    const plain = stripAnsi(output)

    expect(plain).toContain('████')
    expect(plain).toContain('v0.3.5')
    expect(plain).toContain('DEVELOPER AGENT RUNTIME')
    expect(plain).toContain('MiniMax-M3')
    expect(plain).toContain('WORKSPACE')
    expect(plain).toContain('/project/demo')
    expect(plain).toContain('RUNTIME')
    expect(plain).toContain('SOURCE')
    expect(plain).toContain('SYSTEMS')
    expect(plain).toContain('● READY')

    const promptPrefix = renderer.writePrompt()
    renderer.closePrompt()
    renderer.beginAssistantText()
    renderer.streamToken('first line\nsecond line')
    renderer.endAssistantText()
    const conversation = stripAnsi(output + promptPrefix)
    expect(conversation).toContain('╭─ ask ovolv999')
    expect(conversation).toContain('│ ›')
    expect(conversation).toContain('● first line')
    expect(conversation).toContain('    second line')
  })

  it('redraws submitted wide text as a closed multiline prompt', () => {
    let output = ''
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk)
        callback()
      },
    })
    const renderer = new Renderer({ stream })
    renderer.writePrompt()
    renderer.closePrompt('？'.repeat(50), true)
    const plain = stripAnsi(output)
    const content = plain.split('\n').filter(line => line.includes('│'))

    expect(plain).toContain('╭─ ask ovolv999')
    expect(content.length).toBe(2)
    expect(content[0]).toContain('│ ›')
    expect(content[1]).toMatch(/│\s+？？/)
    expect(content.every(line => line.endsWith('│'))).toBe(true)
  })
})
