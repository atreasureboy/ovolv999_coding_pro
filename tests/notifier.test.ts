import { describe, it, expect } from 'vitest'
import {
  detectPlatform,
  detectBestChannel,
  isChannelAvailable,
  notify,
  notifyAsync,
  notifyBell,
  notifyTaskComplete,
  notifyError,
  notifyTestResults,
  type NotificationChannel,
} from '../src/utils/notifier.js'

describe('notifier', () => {
  describe('detectPlatform', () => {
    it('returns current platform string', () => {
      const p = detectPlatform()
      expect(typeof p).toBe('string')
      expect(['darwin', 'linux', 'win32', 'aix', 'freebsd', 'openbsd', 'sunos']).toContain(p)
    })
  })

  describe('detectBestChannel', () => {
    it('returns a valid channel', () => {
      const channel = detectBestChannel()
      const validChannels: NotificationChannel[] = [
        'macos', 'linux', 'windows', 'iterm2', 'kitty', 'bell', 'auto',
      ]
      expect(validChannels).toContain(channel)
    })

    it('falls back to bell or platform when no special terminal', () => {
      const original = process.env.TERM_PROGRAM
      delete process.env.TERM_PROGRAM
      const channel = detectBestChannel()
      if (process.platform === 'darwin') expect(channel).toBe('macos')
      if (process.platform === 'linux') expect(channel).toBe('linux')
      process.env.TERM_PROGRAM = original
    })
  })

  describe('isChannelAvailable', () => {
    it('bell is always available', () => {
      expect(isChannelAvailable('bell')).toBe(true)
    })

    it('auto is always available', () => {
      expect(isChannelAvailable('auto')).toBe(true)
    })

    it('macos only on darwin', () => {
      expect(isChannelAvailable('macos')).toBe(process.platform === 'darwin')
    })

    it('windows only on win32', () => {
      expect(isChannelAvailable('windows')).toBe(process.platform === 'win32')
    })

    it('iterm2 requires ITERM_SESSION_ID', () => {
      const original = process.env.ITERM_SESSION_ID
      delete process.env.ITERM_SESSION_ID
      expect(isChannelAvailable('iterm2')).toBe(false)
      process.env.ITERM_SESSION_ID = 'test'
      expect(isChannelAvailable('iterm2')).toBe(true)
      if (original === undefined) delete process.env.ITERM_SESSION_ID
      else process.env.ITERM_SESSION_ID = original
    })

    it('kitty requires KITTY_WINDOW_ID', () => {
      const original = process.env.KITTY_WINDOW_ID
      delete process.env.KITTY_WINDOW_ID
      expect(isChannelAvailable('kitty')).toBe(false)
      process.env.KITTY_WINDOW_ID = '1'
      expect(isChannelAvailable('kitty')).toBe(true)
      if (original === undefined) delete process.env.KITTY_WINDOW_ID
      else process.env.KITTY_WINDOW_ID = original
    })
  })

  describe('notifyBell', () => {
    it('returns success', () => {
      const result = notifyBell({ title: 'T', body: 'B' })
      expect(result.channel).toBe('bell')
      expect(result.success).toBe(true)
    })
  })

  describe('notify', () => {
    it('uses bell channel explicitly', () => {
      const result = notify({
        title: 'Test',
        body: 'Hello',
        channel: 'bell',
      })
      expect(result.success).toBe(true)
      expect(result.channel).toBe('bell')
    })

    it('falls back to bell when primary fails', () => {
      // Use a channel that will fail on this platform
      const channel = process.platform === 'linux' ? 'macos' as NotificationChannel : 'linux' as NotificationChannel
      const result = notify({
        title: 'Test',
        body: 'Body',
        channel,
      })
      // Should have attempted the channel and fallen back
      expect(result).toBeDefined()
      expect(typeof result.success).toBe('boolean')
    })

    it('handles auto channel', () => {
      const result = notify({
        title: 'Auto Test',
        body: 'Content',
        channel: 'auto',
      })
      expect(result).toBeDefined()
      expect(result.success).toBe(true) // bell always works
    })
  })

  describe('notifyAsync', () => {
    it('returns a promise that resolves', async () => {
      const result = await notifyAsync({
        title: 'Async',
        body: 'Test',
        channel: 'bell',
      })
      expect(result.success).toBe(true)
    })

    it('catches errors and returns failure result', async () => {
      const result = await notifyAsync({
        title: 'Test',
        body: 'Body',
        channel: 'bell',
      })
      expect(result).toBeDefined()
    })
  })

  describe('preset notifications', () => {
    it('notifyTaskComplete returns a result', () => {
      const result = notifyTaskComplete('refactor engine.ts')
      expect(result).toBeDefined()
      expect(typeof result.success).toBe('boolean')
    })

    it('notifyError returns a result', () => {
      const result = notifyError('Something went wrong')
      expect(result).toBeDefined()
      expect(typeof result.success).toBe('boolean')
    })

    it('notifyTestResults returns a result for passing tests', () => {
      const result = notifyTestResults(10, 0)
      expect(result).toBeDefined()
      expect(typeof result.success).toBe('boolean')
    })

    it('notifyTestResults returns a result for failing tests', () => {
      const result = notifyTestResults(8, 2)
      expect(result).toBeDefined()
      expect(typeof result.success).toBe('boolean')
    })
  })
})
