/**
 * Tests for the cleanup utility.
 *
 * We mock process.on/off to avoid actually emitting signals (which
 * would crash the vitest worker process).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { registerCleanup } from '../src/utils/cleanup.js'

describe('registerCleanup', () => {
  let originalIsTTY: boolean | undefined
  let onSpy: ReturnType<typeof vi.spyOn>
  let offSpy: ReturnType<typeof vi.spyOn>
  let exitSpy: ReturnType<typeof vi.spyOn>
  let registeredHandlers: Map<string, (...args: unknown[]) => void>

  beforeEach(() => {
    originalIsTTY = process.stdin.isTTY
    registeredHandlers = new Map()
    onSpy = vi.spyOn(process, 'on').mockImplementation(((event: string, handler: (...args: unknown[]) => void) => {
      registeredHandlers.set(event, handler)
      return process
    }) as never)
    offSpy = vi.spyOn(process, 'off').mockImplementation(((event: string) => {
      registeredHandlers.delete(event)
      return process
    }) as never)
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }))
  })

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalIsTTY,
      writable: true,
    })
    onSpy.mockRestore()
    offSpy.mockRestore()
    exitSpy.mockRestore()
  })

  it('calls onCleanup when cleanup function is invoked', () => {
    const onCleanup = vi.fn()
    const cleanup = registerCleanup({ onCleanup })
    cleanup()
    expect(onCleanup).toHaveBeenCalledTimes(1)
  })

  it('is idempotent — calling cleanup twice does not call onCleanup twice', () => {
    const onCleanup = vi.fn()
    const cleanup = registerCleanup({ onCleanup })
    cleanup()
    cleanup()
    expect(onCleanup).toHaveBeenCalledTimes(1)
  })

  it('registers handlers for SIGTERM and SIGHUP', () => {
    registerCleanup()
    expect(registeredHandlers.has('SIGTERM')).toBe(true)
    expect(registeredHandlers.has('SIGHUP')).toBe(true)
  })

  it('registers handlers for uncaughtException and unhandledRejection', () => {
    registerCleanup()
    expect(registeredHandlers.has('uncaughtException')).toBe(true)
    expect(registeredHandlers.has('unhandledRejection')).toBe(true)
  })

  it('calls onCleanup when SIGTERM handler fires', () => {
    const onCleanup = vi.fn()
    registerCleanup({ onCleanup })
    const handler = registeredHandlers.get('SIGTERM')!
    expect(() => handler()).toThrow('process.exit called')
    expect(onCleanup).toHaveBeenCalledTimes(1)
  })

  it('calls onCleanup when SIGHUP handler fires', () => {
    const onCleanup = vi.fn()
    registerCleanup({ onCleanup })
    const handler = registeredHandlers.get('SIGHUP')!
    expect(() => handler()).toThrow('process.exit called')
    expect(onCleanup).toHaveBeenCalledTimes(1)
  })

  it('calls onCleanup when uncaughtException handler fires', () => {
    const onCleanup = vi.fn()
    registerCleanup({ onCleanup })
    const handler = registeredHandlers.get('uncaughtException')!
    expect(() => handler(new Error('boom'))).toThrow('process.exit called')
    expect(onCleanup).toHaveBeenCalledTimes(1)
  })

  it('calls onCleanup when unhandledRejection handler fires', () => {
    const onCleanup = vi.fn()
    registerCleanup({ onCleanup })
    const handler = registeredHandlers.get('unhandledRejection')!
    // Use a pre-rejected promise but catch it locally to avoid vitest detecting it
    const rejected = Promise.reject(new Error('oops'))
    rejected.catch(() => {}) // prevent unhandled rejection warning
    expect(() => handler(rejected)).toThrow('process.exit called')
    expect(onCleanup).toHaveBeenCalledTimes(1)
  })

  it('unregisters all handlers when cleanup function is called', () => {
    const cleanup = registerCleanup()
    cleanup()
    // After cleanup, handlers should be removed
    expect(registeredHandlers.has('SIGTERM')).toBe(false)
    expect(registeredHandlers.has('SIGHUP')).toBe(false)
    expect(registeredHandlers.has('uncaughtException')).toBe(false)
    expect(registeredHandlers.has('unhandledRejection')).toBe(false)
  })

  it('handles missing onCleanup gracefully', () => {
    const cleanup = registerCleanup()
    expect(() => cleanup()).not.toThrow()
  })

  it('survives onCleanup throwing', () => {
    const onCleanup = vi.fn(() => { throw new Error('cleanup failed') })
    const cleanup = registerCleanup({ onCleanup })
    expect(() => cleanup()).not.toThrow()
  })

  it('disables raw mode during cleanup', () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true })
    const setRawSpy = vi.fn()
    Object.defineProperty(process.stdin, 'setRawMode', { value: setRawSpy, writable: true, configurable: true })
    const cleanup = registerCleanup()
    cleanup()
    expect(setRawSpy).toHaveBeenCalledWith(false)
  })

  it('does not call setRawMode when not TTY', () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, writable: true })
    const setRawSpy = vi.fn()
    Object.defineProperty(process.stdin, 'setRawMode', { value: setRawSpy, writable: true, configurable: true })
    const cleanup = registerCleanup()
    cleanup()
    expect(setRawSpy).not.toHaveBeenCalled()
  })
})
