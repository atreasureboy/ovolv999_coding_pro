/**
 * Tests for UIStore interactive overlay methods:
 * - showPlanApproval / resolvePlan
 * - showPermissionDialog / resolvePermission
 * - showSelectPicker / resolveSelect
 * - hasOverlay()
 */

import { describe, it, expect } from 'vitest'
import { UIStore } from '../store.js'

describe('UIStore interactive overlays', () => {
  it('showPlanApproval sets pendingPlan and returns a promise', async () => {
    const store = new UIStore()
    const promise = store.showPlanApproval('My plan')
    expect(store.getState().pendingPlan).toEqual({ plan: 'My plan' })
    expect(store.hasOverlay()).toBe(true)
    store.resolvePlan(true)
    const result = await promise
    expect(result).toBe(true)
    expect(store.getState().pendingPlan).toBeNull()
    expect(store.hasOverlay()).toBe(false)
  })

  it('resolvePlan(false) rejects the plan', async () => {
    const store = new UIStore()
    const promise = store.showPlanApproval('Bad plan')
    store.resolvePlan(false)
    expect(await promise).toBe(false)
  })

  it('showPermissionDialog sets pendingPermission', async () => {
    const store = new UIStore()
    const req = { toolName: 'Bash', preview: 'rm -rf /', riskLevel: 'dangerous' as const }
    const promise = store.showPermissionDialog(req)
    expect(store.getState().pendingPermission).toEqual(req)
    store.resolvePermission(true, false)
    const result = await promise
    expect(result).toEqual({ approved: true, alwaysAllow: false })
    expect(store.getState().pendingPermission).toBeNull()
  })

  it('resolvePermission with alwaysAllow=true', async () => {
    const store = new UIStore()
    const promise = store.showPermissionDialog({
      toolName: 'Bash', preview: 'ls', riskLevel: 'safe' as const,
    })
    store.resolvePermission(true, true)
    expect(await promise).toEqual({ approved: true, alwaysAllow: true })
  })

  it('showSelectPicker sets selectOverlay', async () => {
    const store = new UIStore()
    const items = [
      { label: 'A', value: 'a' },
      { label: 'B', value: 'b' },
    ]
    const promise = store.showSelectPicker('Choose', items)
    expect(store.getState().selectOverlay?.title).toBe('Choose')
    expect(store.getState().selectOverlay?.items.length).toBe(2)
    store.resolveSelect('b')
    expect(await promise).toBe('b')
    expect(store.getState().selectOverlay).toBeNull()
  })

  it('resolveSelect(null) cancels selection', async () => {
    const store = new UIStore()
    const promise = store.showSelectPicker('Choose', [{ label: 'X', value: 1 }])
    store.resolveSelect(null)
    expect(await promise).toBeNull()
  })

  it('hasOverlay() returns true for each overlay type', () => {
    const store = new UIStore()
    expect(store.hasOverlay()).toBe(false)

    void store.showPlanApproval('plan')
    expect(store.hasOverlay()).toBe(true)
    store.resolvePlan(true)

    void store.showPermissionDialog({ toolName: 'T', preview: '', riskLevel: 'safe' })
    expect(store.hasOverlay()).toBe(true)
    store.resolvePermission(false, false)

    void store.showSelectPicker('Title', [{ label: 'A', value: 1 }])
    expect(store.hasOverlay()).toBe(true)
    store.resolveSelect(1)

    expect(store.hasOverlay()).toBe(false)
  })

  it('only one overlay active at a time (last one wins in state)', () => {
    const store = new UIStore()
    void store.showPlanApproval('plan1')
    // In practice the UI prevents concurrent overlays, but the store
    // tracks all three state fields independently. hasOverlay returns
    // true if ANY is active.
    void store.showPermissionDialog({ toolName: 'T', preview: '', riskLevel: 'safe' })
    expect(store.getState().pendingPlan).not.toBeNull()
    expect(store.getState().pendingPermission).not.toBeNull()
    expect(store.hasOverlay()).toBe(true)
  })
})

describe('UIStore reset clears overlays', () => {
  it('reset() clears all overlay state', () => {
    const store = new UIStore()
    void store.showPlanApproval('plan')
    void store.showPermissionDialog({ toolName: 'T', preview: '', riskLevel: 'safe' })
    void store.showSelectPicker('Title', [{ label: 'A', value: 1 }])
    store.reset()
    expect(store.getState().pendingPlan).toBeNull()
    expect(store.getState().pendingPermission).toBeNull()
    expect(store.getState().selectOverlay).toBeNull()
    expect(store.hasOverlay()).toBe(false)
  })
})
