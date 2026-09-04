import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  loadTeamConfig,
  saveTeamConfig,
  findMemoryFiles,
  loadMemoryFiles,
  formatTeamMemoryStatus,
  getTeamMemoryConfigPath,
} from '../src/core/teamMemory.js'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let testDir: string
let origHome: string | undefined

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), 'ovolv999-team-'))
  origHome = process.env.HOME
  process.env.HOME = testDir
})

afterAll(() => {
  if (origHome !== undefined) process.env.HOME = origHome
  rmSync(testDir, { recursive: true, force: true })
})

describe('teamMemory', () => {
  describe('config', () => {
    it('returns null when no config', () => {
      expect(loadTeamConfig()).toBeNull()
    })

    it('saves and loads config', () => {
      saveTeamConfig({
        remoteUrl: 'https://github.com/team/memory.git',
        branch: 'main',
        files: ['CLAUDE.md'],
        autoSync: true,
      })
      const config = loadTeamConfig()
      expect(config).toBeTruthy()
      expect(config!.remoteUrl).toBe('https://github.com/team/memory.git')
      expect(config!.files).toEqual(['CLAUDE.md'])
    })
  })

  describe('findMemoryFiles', () => {
    it('finds existing memory files', () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'proj-'))
      try {
        writeFileSync(join(projectDir, 'CLAUDE.md'), '# Claude memory')
        writeFileSync(join(projectDir, 'AGENTS.md'), '# Agents memory')
        const files = findMemoryFiles(projectDir)
        expect(files.length).toBeGreaterThanOrEqual(2)
        expect(files.some(f => f.endsWith('CLAUDE.md'))).toBe(true)
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
      }
    })

    it('returns empty when none exist', () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'empty-'))
      try {
        expect(findMemoryFiles(projectDir)).toHaveLength(0)
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
      }
    })
  })

  describe('loadMemoryFiles', () => {
    it('loads file contents', () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'proj-'))
      try {
        const memPath = join(projectDir, 'CLAUDE.md')
        writeFileSync(memPath, '# Memory content')
        const loaded = loadMemoryFiles([memPath])
        expect(loaded).toHaveLength(1)
        expect(loaded[0].content).toBe('# Memory content')
        expect(loaded[0].hash).toBeTruthy()
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
      }
    })

    it('skips non-existent files', () => {
      const loaded = loadMemoryFiles(['/nonexistent.md'])
      expect(loaded).toHaveLength(0)
    })
  })

  describe('formatTeamMemoryStatus', () => {
    it('shows not configured message', () => {
      // Reset config
      const configPath = getTeamMemoryConfigPath()
      if (existsSync(configPath)) rmSync(configPath)
      const status = formatTeamMemoryStatus()
      expect(status).toContain('not configured')
    })

    it('shows status when configured', () => {
      saveTeamConfig({
        remoteUrl: 'https://example.com/team.git',
        files: ['CLAUDE.md'],
      })
      const status = formatTeamMemoryStatus()
      expect(status).toContain('Team Memory Status')
      expect(status).toContain('example.com')
    })
  })
})

describe('team-memory config corruption guard', () => {
  it('preserves a corrupt config before resetting', () => {
    const path = getTeamMemoryConfigPath()
    const backup = `${path}.corrupt`
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '{"remoteUrl": "git@torn"', 'utf8')

    expect(loadTeamConfig()).toBeNull()
    expect(readFileSync(backup, 'utf8')).toBe('{"remoteUrl": "git@torn"')

    // /team-memory add does loadTeamConfig() ?? default → save; the
    // forensic backup must survive that replacement.
    saveTeamConfig({ remoteUrl: 'https://x.git', files: [] })
    expect(loadTeamConfig()!.remoteUrl).toBe('https://x.git')
    expect(readFileSync(backup, 'utf8')).toBe('{"remoteUrl": "git@torn"')
  })

  it('treats a config missing files array as corrupt', () => {
    const path = getTeamMemoryConfigPath()
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '{"remoteUrl": "https://x.git"}', 'utf8')
    expect(loadTeamConfig()).toBeNull()
    expect(existsSync(`${path}.corrupt`)).toBe(true)
  })
})
