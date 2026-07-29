/**
 * v0.4.1 C1 (callId truth) — UIStore result attribution.
 *
 * Pre-C1, setToolResult/setAgentDone position-guessed when no id matched:
 * "attach to the last resultless tool call" / "the last running agent".
 * Under parallel execution that silently misattributed results —
 * tool B's output shown under tool A. The guesses are gone: unmatched
 * results render as VISIBLE orphan warn rows, and InkRenderer never
 * substitutes a name/desc where a callId/runId belongs.
 */
import { describe, it, expect } from 'vitest'
import { UIStore, type UIMessage } from '../../src/ui/ink/store.js'
import { InkRenderer } from '../../src/ui/ink/inkRenderer.js'

function warnTexts(store: UIStore): string[] {
  return store.getState().messages.flatMap((m) => (m.type === 'warn' ? [m.text] : []))
}

function toolMsg(store: UIStore, callId: string): Extract<UIMessage, { type: 'tool' }> | undefined {
  const m = store.getState().messages.find((x) => x.type === 'tool' && x.callId === callId)
  return m && m.type === 'tool' ? m : undefined
}

function msgById(store: UIStore, id: number): UIMessage | undefined {
  return store.getState().messages.find((x) => x.id === id)
}

function agentMsg(store: UIStore, id: number): Extract<UIMessage, { type: 'agent' }> | undefined {
  const m = msgById(store, id)
  return m && m.type === 'agent' ? m : undefined
}

describe('UIStore attribution truth (v0.4.1 C1)', () => {
  it('attributes results by callId with parallel tools in flight', () => {
    const store = new UIStore()
    store.addToolStart('read_file', {}, 'c1')
    store.addToolStart('bash', {}, 'c2')
    store.setToolResult('c1', 'result-1', false)
    expect(toolMsg(store, 'c1')?.result).toBe('result-1')
    expect(toolMsg(store, 'c2')?.result).toBeUndefined()
    expect(warnTexts(store)).toHaveLength(0)
  })

  it('renders a visible orphan when a result carries no callId (no positional guess)', () => {
    const store = new UIStore()
    store.addToolStart('read_file', {}, 'c1')
    store.setToolResult(undefined, 'lost-result', true)
    // the in-flight call must NOT have absorbed it
    expect(toolMsg(store, 'c1')?.result).toBeUndefined()
    expect(warnTexts(store)).toEqual(['(unattributed tool result · error) lost-result'])
  })

  it('renders a visible orphan when the callId matches nothing', () => {
    const store = new UIStore()
    store.addToolStart('bash', {}, 'c2')
    store.setToolResult('call_never_seen', 'orphan-2', false)
    expect(toolMsg(store, 'c2')?.result).toBeUndefined()
    expect(warnTexts(store)).toEqual(['(unattributed tool result) orphan-2'])
  })

  it('truncates orphan snippets to 200 chars', () => {
    const store = new UIStore()
    store.setToolResult(undefined, 'x'.repeat(250), false)
    const [text] = warnTexts(store)
    expect(text).toContain('x'.repeat(200) + '…')
    expect(text).not.toContain('x'.repeat(201))
  })

  it('renders a visible orphan for agent results with no matchable run', () => {
    const store = new UIStore()
    const id = store.addAgentStart('investigate', 'general-purpose', 'r1')
    store.setAgentDone(undefined, false, 'gave up')
    expect(agentMsg(store, id)?.status).toBe('running')
    expect(warnTexts(store)).toEqual(['(unattributed agent result · failed) gave up'])
    // a real runId still attributes correctly afterwards
    store.setAgentDone('r1', true)
    expect(agentMsg(store, id)?.status).toBe('done')
  })

  it('never position-guesses "the last running agent"', () => {
    const store = new UIStore()
    const a = store.addAgentStart('first', 'general-purpose', 'r1')
    const b = store.addAgentStart('second', 'general-purpose', 'r2')
    store.setAgentDone(undefined, true, 'done-ish')
    expect(agentMsg(store, a)?.status).toBe('running')
    expect(agentMsg(store, b)?.status).toBe('running')
    expect(warnTexts(store)).toHaveLength(1)
  })

  it('InkRenderer.toolResult without callId does not match by name', () => {
    const store = new UIStore()
    const renderer = new InkRenderer(store)
    store.addToolStart('read_file', {}, 'c1')
    renderer.toolResult('read_file', 'should-orphan', false)
    expect(toolMsg(store, 'c1')?.result).toBeUndefined()
    expect(warnTexts(store)).toEqual(['(unattributed tool result) should-orphan'])
  })

  it('InkRenderer.agentDone without runId does not match by desc', () => {
    const store = new UIStore()
    const renderer = new InkRenderer(store)
    const id = store.addAgentStart('investigate', 'general-purpose', 'r1')
    renderer.agentDone('investigate', true)
    expect(agentMsg(store, id)?.status).toBe('running')
    expect(warnTexts(store)).toHaveLength(1)
    expect(warnTexts(store)[0]).toContain('unattributed agent result')
  })
})
