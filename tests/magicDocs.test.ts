/**
 * Tests for src/core/magicDocs.ts
 *
 * Uses a temp project directory with sample source files to exercise
 * the extractors deterministically.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  discoverFiles, extractDocs, formatResult, formatSection,
} from '../src/core/magicDocs.js'
import { writeFileSync, rmSync, mkdtempSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let testProject: string

beforeAll(() => {
  testProject = mkdtempSync(join(tmpdir(), 'magicdocs-'))

  // Express-like API routes
  writeFileSync(join(testProject, 'server.ts'), `
import express from 'express'
const app = express()
app.get('/api/users', (req, res) => {})
app.post('/api/users', (req, res) => {})
app.delete('/api/users/:id', (req, res) => {})
app.put('/api/users/:id', (req, res) => {})
`)

  // Data models
  writeFileSync(join(testProject, 'models.ts'), `
export interface User {
  id: string
  name: string
  email: string
}

export type UserRole = 'admin' | 'user' | 'guest'

const UserSchema = z.object({ id: z.string() })
`)

  // Config
  writeFileSync(join(testProject, 'config.ts'), `
const apiKey = process.env.API_KEY
const port = process.env.PORT ?? 3000
const dbUrl = process.env.DATABASE_URL
`)

  // Decisions / TODOs
  writeFileSync(join(testProject, 'legacy.ts'), `
// TODO: refactor this to use async/await
// FIXME: race condition in concurrent access
// DECISION: chose Redis for caching because of low latency
// HACK: temporary workaround for issue #123
function oldCode() {}
`)

  // Patterns
  writeFileSync(join(testProject, 'service.ts'), `
export class UserService {
  async getUser(id: string) {}
}

export function formatDate(d: Date) {}

export async function fetchData() {}
`)

  // Dependencies
  writeFileSync(join(testProject, 'deps.ts'), `
import express from 'express'
import { z } from 'zod'
import _ from 'lodash'
import { something } from './local'
`)
})

afterAll(() => {
  rmSync(testProject, { recursive: true, force: true })
})

describe('magicDocs', () => {
  describe('discoverFiles', () => {
    it('discovers source files', () => {
      const files = discoverFiles(testProject)
      expect(files.length).toBeGreaterThan(0)
      expect(files.some((f) => f.endsWith('server.ts'))).toBe(true)
      expect(files.some((f) => f.endsWith('models.ts'))).toBe(true)
    })

    it('respects maxFiles', () => {
      const files = discoverFiles(testProject, undefined, 2)
      expect(files.length).toBeLessThanOrEqual(2)
    })
  })

  describe('extractDocs — full', () => {
    let result: ReturnType<typeof extractDocs>

    beforeAll(() => {
      result = extractDocs({ rootDir: testProject })
    })

    it('returns sections', () => {
      expect(result.sections.length).toBeGreaterThan(0)
    })

    it('reports file count', () => {
      expect(result.fileCount).toBeGreaterThan(0)
    })

    it('reports line count', () => {
      expect(result.lineCount).toBeGreaterThan(0)
    })

    it('includes overview section', () => {
      const overview = result.sections.find((s) => s.type === 'overview')
      expect(overview).toBeDefined()
      expect(overview!.content).toContain('Files scanned')
    })

    it('extracts API endpoints', () => {
      const api = result.sections.find((s) => s.type === 'api')
      expect(api).toBeDefined()
      expect(api!.content).toContain('/api/users')
      expect(api!.content).toContain('GET')
      expect(api!.content).toContain('POST')
      expect(api!.content).toContain('DELETE')
    })

    it('extracts data models', () => {
      const models = result.sections.find((s) => s.type === 'models')
      expect(models).toBeDefined()
      expect(models!.content).toContain('User')
      expect(models!.content).toContain('interface')
    })

    it('extracts config variables', () => {
      const config = result.sections.find((s) => s.type === 'config')
      expect(config).toBeDefined()
      expect(config!.content).toContain('API_KEY')
      expect(config!.content).toContain('PORT')
      expect(config!.content).toContain('DATABASE_URL')
    })

    it('extracts decisions and TODOs', () => {
      const decisions = result.sections.find((s) => s.type === 'decisions')
      expect(decisions).toBeDefined()
      expect(decisions!.content).toContain('TODO')
      expect(decisions!.content).toContain('FIXME')
      expect(decisions!.content).toContain('DECISION')
    })

    it('extracts code patterns', () => {
      const patterns = result.sections.find((s) => s.type === 'patterns')
      expect(patterns).toBeDefined()
      expect(patterns!.content).toContain('UserService')
    })

    it('extracts dependencies', () => {
      const deps = result.sections.find((s) => s.type === 'dependencies')
      expect(deps).toBeDefined()
      expect(deps!.content).toContain('express')
      expect(deps!.content).toContain('zod')
    })
  })

  describe('extractDocs — section filtering', () => {
    it('respects sections option', () => {
      const result = extractDocs({ rootDir: testProject, sections: ['api'] })
      expect(result.sections.length).toBe(1)
      expect(result.sections[0].type).toBe('api')
    })
  })

  describe('extractDocs — output file', () => {
    it('writes to outputPath', () => {
      const outputPath = join(testProject, '.out', 'docs.md')
      extractDocs({ rootDir: testProject, outputPath })
      expect(existsSync(outputPath)).toBe(true)
      const content = readFileSync(outputPath, 'utf8')
      expect(content).toContain('MagicDocs')
    })
  })

  describe('extractDocs — edge cases', () => {
    it('handles nonexistent root', () => {
      const result = extractDocs({ rootDir: '/nonexistent/path' })
      expect(result.sections).toEqual([])
      expect(result.warnings.length).toBeGreaterThan(0)
    })

    it('handles empty directory', () => {
      const empty = mkdtempSync(join(tmpdir(), 'magic-empty-'))
      try {
        const result = extractDocs({ rootDir: empty })
        expect(result.fileCount).toBe(0)
        // Extraction sections (not overview) report "No ... detected"
        for (const s of result.sections) {
          if (s.type === 'overview') continue
          expect(s.content).toMatch(/No .*(detected|found)/)
        }
      } finally {
        rmSync(empty, { recursive: true, force: true })
      }
    })
  })

  describe('formatting', () => {
    it('formatResult produces markdown', () => {
      const result = extractDocs({ rootDir: testProject })
      const out = formatResult(result)
      expect(out).toContain('# MagicDocs')
      expect(out).toContain('## ')
    })

    it('formatSection shows title + content', () => {
      const result = extractDocs({ rootDir: testProject })
      const section = result.sections[0]
      const out = formatSection(section)
      expect(out).toContain(section.title)
    })
  })
})
