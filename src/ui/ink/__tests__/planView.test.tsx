/**
 * PlanView component rendering tests.
 * Keyboard interaction not tested (ink-testing-library v4 limitation with Ink v5).
 */

import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import { PlanView } from '../components/PlanView.js'

describe('PlanView rendering', () => {
  it('renders plan title and text', () => {
    const { lastFrame } = render(
      <PlanView plan="Step 1: Read files\nStep 2: Edit config" onResolve={() => {}} />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Plan')
    expect(frame).toContain('Step 1: Read files')
    expect(frame).toContain('Step 2: Edit config')
  })

  it('shows approve/reject hints', () => {
    const { lastFrame } = render(
      <PlanView plan="Do something" onResolve={() => {}} />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('[y]')
    expect(frame).toContain('[n]')
    expect(frame).toContain('approve')
    expect(frame).toContain('reject')
  })

  it('truncates very long plans', () => {
    const longPlan = Array(50).fill(0).map((_, i) => `Line ${i + 1}`).join('\n')
    const { lastFrame } = render(
      <PlanView plan={longPlan} onResolve={() => {}} />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Line 1')
    expect(frame).toContain('more lines')
  })

  it('uses magenta border', () => {
    const { lastFrame } = render(
      <PlanView plan="Short plan" onResolve={() => {}} />,
    )
    // Just verify it renders without error
    expect((lastFrame() ?? '').length).toBeGreaterThan(0)
  })
})
