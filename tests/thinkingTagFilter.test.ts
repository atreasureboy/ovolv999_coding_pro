import { describe, expect, it } from 'vitest'
import { ThinkingTagFilter } from '../src/core/thinkingTagFilter.js'

describe('ThinkingTagFilter', () => {
  it('removes a complete thinking block', () => {
    const filter = new ThinkingTagFilter()
    expect(filter.push('<think>private reasoning</think>OK')).toBe('OK')
    expect(filter.finish()).toBe('')
  })

  it('handles tags split across stream chunks', () => {
    const filter = new ThinkingTagFilter()
    const chunks = ['<thi', 'nk>reason', 'ing</th', 'ink>', 'visible']
    expect(chunks.map(chunk => filter.push(chunk)).join('') + filter.finish()).toBe('visible')
  })

  it('preserves ordinary angle-bracket content', () => {
    const filter = new ThinkingTagFilter()
    expect(filter.push('Use <thing>value</thing>.') + filter.finish()).toBe('Use <thing>value</thing>.')
  })

  it('drops an unterminated thinking block at end of stream', () => {
    const filter = new ThinkingTagFilter()
    expect(filter.push('before<think>secret')).toBe('before')
    expect(filter.finish()).toBe('')
  })
})
