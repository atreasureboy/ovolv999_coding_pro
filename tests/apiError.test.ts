/**
 * Tests for the API error formatting utility.
 */

import { describe, it, expect } from 'vitest'
import { formatApiError, formatErrorInline } from '../src/utils/apiError.js'

describe('formatApiError', () => {
  it('formats 401 auth errors', () => {
    const err = new Error('Request failed with status 401')
    ;(err as Error & { status: number }).status = 401
    const fe = formatApiError(err)
    expect(fe.title).toBe('Authentication failed')
    expect(fe.hint).toContain('API_KEY')
  })

  it('formats invalid api key messages', () => {
    const err = new Error('Invalid API key provided')
    const fe = formatApiError(err)
    expect(fe.title).toBe('Authentication failed')
  })

  it('formats 403 forbidden errors', () => {
    const err = new Error('Forbidden')
    ;(err as Error & { status: number }).status = 403
    const fe = formatApiError(err)
    expect(fe.title).toBe('Access forbidden')
    expect(fe.hint).toContain('billing')
  })

  it('formats 404 model not found errors', () => {
    const err = new Error('The model gpt-99 does not exist')
    const fe = formatApiError(err)
    expect(fe.title).toBe('Model not found')
    expect(fe.hint).toContain('/model')
  })

  it('formats 429 rate limit errors', () => {
    const err = new Error('Rate limit exceeded')
    ;(err as Error & { status: number }).status = 429
    const fe = formatApiError(err)
    expect(fe.title).toBe('Rate limited')
    expect(fe.hint).toContain('/retry')
  })

  it('formats 500 server errors', () => {
    const err = new Error('Internal server error')
    ;(err as Error & { status: number }).status = 500
    const fe = formatApiError(err)
    expect(fe.title).toBe('Server error')
    expect(fe.hint).toContain('/retry')
  })

  it('formats 503 service unavailable', () => {
    const err = new Error('Service unavailable')
    ;(err as Error & { status: number }).status = 503
    const fe = formatApiError(err)
    expect(fe.title).toBe('Server error')
  })

  it('formats ECONNREFUSED network errors', () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:8080')
    ;(err as Error & { code: string }).code = 'ECONNREFUSED'
    const fe = formatApiError(err)
    expect(fe.title).toBe('Connection refused')
    expect(fe.hint).toContain('baseUrl')
  })

  it('formats ENOTFOUND network errors', () => {
    const err = new Error('getaddrinfo ENOTFOUND api.example.com')
    ;(err as Error & { code: string }).code = 'ENOTFOUND'
    const fe = formatApiError(err)
    expect(fe.title).toBe('Host not found')
  })

  it('formats ETIMEDOUT timeout errors', () => {
    const err = new Error('Operation timed out')
    ;(err as Error & { code: string }).code = 'ETIMEDOUT'
    const fe = formatApiError(err)
    expect(fe.title).toBe('Request timed out')
  })

  it('formats ECONNRESET errors', () => {
    const err = new Error('read ECONNRESET')
    ;(err as Error & { code: string }).code = 'ECONNRESET'
    const fe = formatApiError(err)
    expect(fe.title).toBe('Connection reset')
  })

  it('formats context_length_exceeded errors', () => {
    const err = new Error('This model maximum context length is 8192 tokens')
    const fe = formatApiError(err)
    expect(fe.title).toBe('Context overflow')
    expect(fe.hint).toContain('/compact')
  })

  it('formats AbortError', () => {
    const err = new Error('The user aborted the request')
    err.name = 'AbortError'
    const fe = formatApiError(err)
    expect(fe.title).toBe('Interrupted')
    expect(fe.hint).toBeUndefined()
  })

  it('falls back to generic error for unknown patterns', () => {
    const err = new Error('Something unexpected happened')
    const fe = formatApiError(err)
    expect(fe.title).toBe('Error')
    expect(fe.detail).toBe('Something unexpected happened')
  })

  it('truncates very long error messages', () => {
    const longMsg = 'x'.repeat(1000)
    const err = new Error(longMsg)
    const fe = formatApiError(err)
    expect(fe.detail.length).toBeLessThanOrEqual(500)
  })

  it('handles non-Error thrown values', () => {
    const fe = formatApiError('just a string')
    expect(fe.title).toBe('Error')
    expect(fe.detail).toBe('just a string')
  })
})

describe('formatErrorInline', () => {
  it('combines title, detail, and hint into one line', () => {
    const err = new Error('Rate limit exceeded')
    ;(err as Error & { status: number }).status = 429
    const line = formatErrorInline(err)
    expect(line).toContain('Rate limited')
    expect(line).toContain('HTTP 429')
    expect(line).toContain('/retry')
  })

  it('omits hint when absent', () => {
    const err = new Error('The user aborted the request')
    err.name = 'AbortError'
    const line = formatErrorInline(err)
    expect(line).toBe('Interrupted: The request was cancelled.')
  })
})
