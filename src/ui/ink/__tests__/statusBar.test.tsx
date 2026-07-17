/**
 * Tests for StatusBar and TodoListView components.
 */

import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import { StatusBar } from '../components/StatusBar.js'
import { TodoListView, type TodoItem } from '../components/TodoListView.js'

describe('StatusBar', () => {
  it('renders model name and message count', () => {
    const { lastFrame } = render(
      <StatusBar model="gpt-4o" messageCount={5} contextPct={0.3} cost={0} apiCalls={0} planMode={false} />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('gpt-4o')
    expect(frame).toContain('5 msgs')
  })

  it('renders context pressure bar', () => {
    const { lastFrame } = render(
      <StatusBar model="m" messageCount={1} contextPct={0.5} cost={0} apiCalls={0} planMode={false} />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('50%')
    expect(frame).toContain('█')
    expect(frame).toContain('░')
  })

  it('shows cost when apiCalls > 0', () => {
    const { lastFrame } = render(
      <StatusBar model="m" messageCount={1} contextPct={0.1} cost={0.0234} apiCalls={5} planMode={false} />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('$')
    expect(frame).toContain('5 API')
  })

  it('hides cost when apiCalls = 0', () => {
    const { lastFrame } = render(
      <StatusBar model="m" messageCount={1} contextPct={0.1} cost={0} apiCalls={0} planMode={false} />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).not.toContain('API')
  })

  it('shows PLAN indicator in plan mode', () => {
    const { lastFrame } = render(
      <StatusBar model="m" messageCount={0} contextPct={0} cost={0} apiCalls={0} planMode={true} />,
    )
    expect((lastFrame() ?? '')).toContain('PLAN')
  })

  it('shows git branch when provided', () => {
    const { lastFrame } = render(
      <StatusBar model="m" messageCount={0} contextPct={0} cost={0} apiCalls={0} planMode={false} gitBranch="feature-x" />,
    )
    expect((lastFrame() ?? '')).toContain('feature-x')
  })

  it('hides git branch when null', () => {
    const { lastFrame } = render(
      <StatusBar model="m" messageCount={0} contextPct={0} cost={0} apiCalls={0} planMode={false} gitBranch={null} />,
    )
    expect((lastFrame() ?? '')).not.toContain('feature')
  })
})

describe('TodoListView', () => {
  const todos: TodoItem[] = [
    { content: 'Read the file', status: 'completed' },
    { content: 'Edit the config', status: 'in_progress' },
    { content: 'Run tests', status: 'pending' },
  ]

  it('renders task header with progress', () => {
    const { lastFrame } = render(<TodoListView todos={todos} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Tasks')
    expect(frame).toContain('1/3')
  })

  it('renders all todo items', () => {
    const { lastFrame } = render(<TodoListView todos={todos} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Read the file')
    expect(frame).toContain('Edit the config')
    expect(frame).toContain('Run tests')
  })

  it('shows correct status icons', () => {
    const { lastFrame } = render(<TodoListView todos={todos} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('☑') // completed
    expect(frame).toContain('→') // in_progress
    expect(frame).toContain('☐') // pending
  })

  it('renders empty list', () => {
    const { lastFrame } = render(<TodoListView todos={[]} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Tasks')
    expect(frame).toContain('0/0')
  })

  it('shows all-complete progress bar in green', () => {
    const allDone: TodoItem[] = [
      { content: 'Task A', status: 'completed' },
      { content: 'Task B', status: 'completed' },
    ]
    const { lastFrame } = render(<TodoListView todos={allDone} />)
    expect((lastFrame() ?? '')).toContain('2/2')
  })
})
