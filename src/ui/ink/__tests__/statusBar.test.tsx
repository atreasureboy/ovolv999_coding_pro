import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { StatusBar } from '../components/StatusBar.js'

function frame(props: Partial<Parameters<typeof StatusBar>[0]>): string {
  return render(<StatusBar contextPct={0.3} planMode={false} {...props} />).lastFrame() ?? ''
}

describe('StatusBar (codex-style footer, Round 46)', () => {
  it('shows the shortcuts hint on the left and remaining context on the right', () => {
    const f = frame({ contextPct: 0.3 })
    expect(f).toContain('? for shortcuts')
    expect(f).toContain('70% context left')
  })

  it('shows remaining context, not used', () => {
    const f = frame({ contextPct: 0.3 })
    expect(f).not.toContain('30% context')
    expect(f).toContain('70% context left')
  })

  it('surfaces Plan mode as a left chip', () => {
    const f = frame({ contextPct: 0.1, planMode: true })
    expect(f).toContain('Plan mode')
  })

  it('surfaces non-standard profiles', () => {
    expect(frame({ contextPct: 0.1, profile: 'fast' })).toContain('fast')
    expect(frame({ contextPct: 0.1, profile: 'deep' })).toContain('deep')
  })

  it('surfaces verbose mode', () => {
    expect(frame({ contextPct: 0.1, verbose: true })).toContain('verbose')
  })

  it('hides context digits near zero usage? no — always shows remaining', () => {
    expect(frame({ contextPct: 0.0 })).toContain('100% context left')
    expect(frame({ contextPct: 0.95 })).toContain('5% context left')
  })

  it('keeps the line quiet: no model, cost, or banner text', () => {
    const f = frame({ contextPct: 0.2 })
    expect(f).not.toContain('$')
    expect(f).not.toContain('BUILD')
    expect(f).not.toContain('ready')
  })
})
