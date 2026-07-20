import { describe, it, expect } from 'vitest'
import {
  ANSI, stripAnsi, ansiLength, bold, dim, red, green,
  progressBar, padRight, padLeft, center, truncate, box,
  hyperlink, getColorSupport, fgRGB, hexToRgb,
} from '../src/utils/ansi.js'

describe('ANSI Utilities', () => {
  describe('basic formatting', () => {
    it('bold wraps text', () => {
      const result = bold('hello')
      expect(result).toContain(ANSI.BOLD)
      expect(stripAnsi(result)).toBe('hello')
    })

    it('dim wraps text', () => {
      expect(stripAnsi(dim('test'))).toBe('test')
    })

    it('red wraps text', () => {
      expect(stripAnsi(red('error'))).toBe('error')
    })

    it('green wraps text', () => {
      expect(stripAnsi(green('ok'))).toBe('ok')
    })
  })

  describe('stripAnsi', () => {
    it('removes ANSI codes', () => {
      const colored = red('hello')
      expect(stripAnsi(colored)).toBe('hello')
    })

    it('handles plain text', () => {
      expect(stripAnsi('hello')).toBe('hello')
    })

    it('handles multiple codes', () => {
      const multi = `${ANSI.BOLD}${ANSI.RED}hello${ANSI.RESET}`
      expect(stripAnsi(multi)).toBe('hello')
    })
  })

  describe('ansiLength', () => {
    it('measures visible text length', () => {
      expect(ansiLength(red('hello'))).toBe(5)
    })

    it('measures plain text', () => {
      expect(ansiLength('hello')).toBe(5)
    })
  })

  describe('progressBar', () => {
    it('renders full bar at 100%', () => {
      const bar = progressBar(1, 10)
      expect(bar).toBe('█'.repeat(10))
    })

    it('renders empty bar at 0%', () => {
      const bar = progressBar(0, 10)
      expect(bar).toBe('░'.repeat(10))
    })

    it('renders partial bar', () => {
      const bar = progressBar(0.5, 10)
      expect(bar).toContain('█')
      expect(bar).toContain('░')
    })

    it('clamps overflow', () => {
      const bar = progressBar(1.5, 5)
      expect(bar).toBe('█'.repeat(5))
    })
  })

  describe('padding', () => {
    it('padRight pads to width', () => {
      expect(padRight('ab', 5)).toBe('ab   ')
    })

    it('padLeft pads to width', () => {
      expect(padLeft('ab', 5)).toBe('   ab')
    })

    it('center centers text', () => {
      expect(center('ab', 6)).toBe('  ab  ')
    })

    it('does not truncate longer text', () => {
      expect(padRight('hello', 3)).toBe('hello')
    })

    it('handles ANSI-colored text', () => {
      const colored = red('ab')
      expect(ansiLength(padRight(colored, 5))).toBe(5)
    })
  })

  describe('truncate', () => {
    it('truncates long text', () => {
      expect(truncate('hello world', 8)).toBe('hello w…')
    })

    it('keeps short text', () => {
      expect(truncate('hi', 10)).toBe('hi')
    })
  })

  describe('hexToRgb', () => {
    it('converts hex to RGB', () => {
      expect(hexToRgb('#FF0000')).toEqual({ r: 255, g: 0, b: 0 })
      expect(hexToRgb('#00FF00')).toEqual({ r: 0, g: 255, b: 0 })
      expect(hexToRgb('#0000FF')).toEqual({ r: 0, g: 0, b: 255 })
    })
  })

  describe('fgRGB', () => {
    it('generates truecolor escape', () => {
      const code = fgRGB('#FF0000')
      expect(code).toContain('38;2;255;0;0')
    })
  })

  describe('box', () => {
    it('draws box around text', () => {
      const result = box('hello')
      const lines = result.split('\n')
      expect(lines[0]).toContain('┌')
      expect(lines[0]).toContain('┐')
      expect(lines[1]).toContain('│')
      expect(lines[1]).toContain('hello')
      expect(lines[2]).toContain('└')
      expect(lines[2]).toContain('┘')
    })

    it('draws box with title', () => {
      const result = box('hello', { title: 'Title' })
      expect(result).toContain('Title')
    })
  })

  describe('hyperlink', () => {
    it('creates OSC 8 hyperlink', () => {
      const link = hyperlink('click', 'https://example.com')
      expect(link).toContain('https://example.com')
      expect(link).toContain('click')
    })
  })

  describe('getColorSupport', () => {
    it('returns a support level', () => {
      const level = getColorSupport()
      expect(['truecolor', '256', 'basic', 'none']).toContain(level)
    })
  })
})
