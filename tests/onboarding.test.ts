import { describe, it, expect } from 'vitest'
import {
  analyzeProject,
  formatOverview,
} from '../src/core/onboarding.js'

describe('onboarding', () => {
  // This project itself is a good test case
  const projectRoot = process.cwd()

  describe('analyzeProject', () => {
    it('returns a ProjectOverview object', () => {
      const overview = analyzeProject(projectRoot)
      expect(overview).toBeDefined()
      expect(typeof overview).toBe('object')
    })

    it('detects project name', () => {
      const overview = analyzeProject(projectRoot)
      expect(overview.name).toBeTruthy()
    })

    it('detects version', () => {
      const overview = analyzeProject(projectRoot)
      expect(overview.version).toBeTruthy()
    })

    it('detects TypeScript as primary language', () => {
      const overview = analyzeProject(projectRoot)
      // This project is TypeScript-heavy
      expect(['TypeScript', 'JavaScript']).toContain(overview.language)
    })

    it('builds directory structure', () => {
      const overview = analyzeProject(projectRoot)
      expect(overview.structure).toBeDefined()
      expect(overview.structure.type).toBe('directory')
      expect(overview.structure.children).toBeDefined()
    })

    it('detects npm dependencies', () => {
      const overview = analyzeProject(projectRoot)
      expect(overview.dependencies.type).toBe('npm')
      expect(overview.dependencies.totalCount).toBeGreaterThan(0)
    })

    it('detects production dependencies', () => {
      const overview = analyzeProject(projectRoot)
      expect(Object.keys(overview.dependencies.production).length).toBeGreaterThan(0)
    })

    it('detects development dependencies', () => {
      const overview = analyzeProject(projectRoot)
      expect(Object.keys(overview.dependencies.development).length).toBeGreaterThan(0)
    })

    it('detects test framework', () => {
      const overview = analyzeProject(projectRoot)
      expect(overview.testSetup.framework).toBeTruthy()
      // This project uses vitest
      expect(['vitest', 'jest']).toContain(overview.testSetup.framework)
    })

    it('detects test directory', () => {
      const overview = analyzeProject(projectRoot)
      expect(overview.testSetup.testDir).toBeTruthy()
    })

    it('detects test files', () => {
      const overview = analyzeProject(projectRoot)
      expect(overview.testSetup.testFileCount).toBeGreaterThan(0)
    })

    it('detects git state', () => {
      const overview = analyzeProject(projectRoot)
      expect(overview.gitState).not.toBeNull()
      expect(overview.gitState!.branch).toBeTruthy()
    })

    it('computes code stats', () => {
      const overview = analyzeProject(projectRoot)
      expect(overview.stats.totalFiles).toBeGreaterThan(0)
      expect(overview.stats.totalLines).toBeGreaterThan(0)
      expect(Object.keys(overview.stats.filesByExtension).length).toBeGreaterThan(0)
    })

    it('finds largest files', () => {
      const overview = analyzeProject(projectRoot)
      expect(overview.stats.largestFiles.length).toBeGreaterThan(0)
      expect(overview.stats.largestFiles[0].lines).toBeGreaterThan(0)
    })

    it('detects conventions', () => {
      const overview = analyzeProject(projectRoot)
      expect(overview.conventions.length).toBeGreaterThan(0)
    })

    it('finds key files', () => {
      const overview = analyzeProject(projectRoot)
      expect(overview.keyFiles).toContain('package.json')
      expect(overview.keyFiles).toContain('tsconfig.json')
    })

    it('detects build system', () => {
      const overview = analyzeProject(projectRoot)
      expect(overview.buildSystem).toBeTruthy()
    })

    it('has scripts from package.json', () => {
      const overview = analyzeProject(projectRoot)
      expect(Object.keys(overview.scripts).length).toBeGreaterThan(0)
    })
  })

  describe('analyzeProject on empty directory', () => {
    it('handles directory with no package.json', () => {
      const overview = analyzeProject('/tmp')
      expect(overview.name).toBeTruthy()
      expect(overview.dependencies.type).not.toBe('npm')
    })
  })

  describe('formatOverview', () => {
    it('produces markdown output', () => {
      const overview = analyzeProject(projectRoot)
      const out = formatOverview(overview)
      expect(out).toContain('# Project Overview')
      expect(out).toContain('## Structure')
      expect(out).toContain('## Statistics')
      expect(out).toContain('## Testing')
    })

    it('includes project name', () => {
      const overview = analyzeProject(projectRoot)
      const out = formatOverview(overview)
      expect(out).toContain(overview.name)
    })

    it('includes language', () => {
      const overview = analyzeProject(projectRoot)
      const out = formatOverview(overview)
      expect(out).toContain(overview.language)
    })

    it('includes stats section', () => {
      const overview = analyzeProject(projectRoot)
      const out = formatOverview(overview)
      expect(out).toContain('Total code files')
      expect(out).toContain('Total lines')
    })

    it('includes tree structure', () => {
      const overview = analyzeProject(projectRoot)
      const out = formatOverview(overview)
      expect(out).toContain('├──')
    })

    it('includes git section when available', () => {
      const overview = analyzeProject(projectRoot)
      if (overview.gitState) {
        const out = formatOverview(overview)
        expect(out).toContain('## Git')
        expect(out).toContain('Branch')
      }
    })

    it('includes dependencies section', () => {
      const overview = analyzeProject(projectRoot)
      const out = formatOverview(overview)
      expect(out).toContain('## Dependencies')
    })

    it('includes testing section', () => {
      const overview = analyzeProject(projectRoot)
      const out = formatOverview(overview)
      expect(out).toContain('## Testing')
    })

    it('includes conventions section', () => {
      const overview = analyzeProject(projectRoot)
      const out = formatOverview(overview)
      expect(out).toContain('## Conventions')
    })

    it('includes key files section', () => {
      const overview = analyzeProject(projectRoot)
      const out = formatOverview(overview)
      expect(out).toContain('## Key Files')
    })
  })

  describe('edge cases', () => {
    it('handles non-existent directory', () => {
      expect(() => analyzeProject('/nonexistent/path/that/does/not/exist')).not.toThrow()
    })

    it('handles directory with no git', () => {
      const overview = analyzeProject('/tmp')
      // /tmp may or may not be git — just check it doesn't throw
      expect(typeof overview).toBe('object')
    })
  })
})
