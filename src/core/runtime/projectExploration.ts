import { readdirSync } from 'node:fs'
import { basename, relative, resolve, sep } from 'node:path'

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.idea',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  '.vscode',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
  'vendor',
])

const ROOT_EVIDENCE = /^(?:agents|ovogo|readme|contributing|architecture)(?:\.[^.]+)?$|^(?:package|tsconfig|pyproject|cargo|go\.mod|composer|gemfile|makefile|dockerfile)/i
const TEST_FILE = /(?:^|\/)(?:test|tests|spec|specs|__tests__)(?:\/|$)|\.(?:test|spec)\.[^.]+$/i
const ENTRY_FILE = /(?:^|\/)(?:main|index|cli|app|server|mod|lib)\.[^.]+$|(?:^|\/)bin\//i
const SOURCE_ROOTS = new Set(['app', 'apps', 'cmd', 'lib', 'packages', 'pkg', 'src'])

export interface ProjectExplorationProfile {
  cwd: string
  files: string[]
  rootEvidence: string[]
  sourceAreas: string[]
  testFiles: string[]
  entryFiles: string[]
  targetReadCount: number
}

export interface ProjectExplorationCriterion {
  id: string
  description: string
  satisfied: boolean
}

export interface ProjectExplorationAssessment {
  complete: boolean
  criteria: ProjectExplorationCriterion[]
  missing: string[]
  filesRead: number
  targetReadCount: number
}

export function isProjectExplorationRequest(message: string): boolean {
  const text = message.trim().toLowerCase()
  return /\b(?:read|inspect|explore|understand|review|audit)\b[\s\S]{0,40}\b(?:project|repository|repo|codebase)\b/.test(text)
    || /\b(?:project|repository|repo|codebase)\b[\s\S]{0,40}\b(?:read|inspect|explore|understand|review|audit)\b/.test(text)
    || /(?:读取|阅读|了解|熟悉|查看|审查|分析)[\s\S]{0,20}(?:项目|仓库|代码库)/.test(text)
    || /(?:项目|仓库|代码库)[\s\S]{0,20}(?:读取|阅读|了解|熟悉|查看|审查|分析)/.test(text)
    || /(?:进一步|继续|深入)[\s\S]{0,12}(?:读取|阅读|了解|查看|分析)/.test(text)
}

export function buildProjectExplorationProfile(cwd: string): ProjectExplorationProfile {
  const root = resolve(cwd)
  const files: string[] = []
  const pending = [root]
  while (pending.length > 0 && files.length < 4000) {
    const directory = pending.pop()
    if (!directory) break
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.cache')) {
          pending.push(resolve(directory, entry.name))
        }
      } else if (entry.isFile()) {
        files.push(relative(root, resolve(directory, entry.name)).split(sep).join('/'))
        if (files.length >= 4000) break
      }
    }
  }

  const rootEvidence = files.filter((file) => !file.includes('/') && ROOT_EVIDENCE.test(basename(file)))
  const testFiles = files.filter((file) => TEST_FILE.test(file))
  const entryFiles = files.filter((file) => ENTRY_FILE.test(file) || (!file.includes('/') && ROOT_EVIDENCE.test(file)))
  const sourceAreas = [...new Set(files.map(sourceArea).filter((area): area is string => Boolean(area)))]
  const targetReadCount = Math.min(16, Math.max(5, Math.ceil(files.length * 0.03)))
  return { cwd: root, files, rootEvidence, sourceAreas, testFiles, entryFiles, targetReadCount }
}

export function assessProjectExploration(
  profile: ProjectExplorationProfile,
  filesRead: readonly string[],
): ProjectExplorationAssessment {
  const read = new Set(filesRead.map((file) => normalizeReadPath(profile.cwd, file)))
  const readCount = [...read].filter((file) => profile.files.includes(file)).length
  const rootTarget = Math.min(2, profile.rootEvidence.length)
  const sourceTarget = Math.min(4, profile.sourceAreas.length)
  const rootRead = profile.rootEvidence.filter((file) => read.has(file)).length
  const sourceAreasRead = profile.sourceAreas.filter((area) =>
    [...read].some((file) => file === area || file.startsWith(`${area}/`)),
  ).length
  const testRead = profile.testFiles.length === 0 || profile.testFiles.some((file) => read.has(file))
  const entryRead = profile.entryFiles.length === 0 || profile.entryFiles.some((file) => read.has(file))

  const criteria: ProjectExplorationCriterion[] = [
    {
      id: 'project-file-sample',
      description: `Inspect a representative file sample (${readCount}/${profile.targetReadCount})`,
      satisfied: readCount >= profile.targetReadCount,
    },
    {
      id: 'project-root-context',
      description: `Inspect root instructions, documentation, and configuration (${rootRead}/${rootTarget})`,
      satisfied: rootRead >= rootTarget,
    },
    {
      id: 'project-source-areas',
      description: `Inspect representative implementation areas (${sourceAreasRead}/${sourceTarget})`,
      satisfied: sourceAreasRead >= sourceTarget,
    },
    {
      id: 'project-entrypoints',
      description: 'Inspect a manifest or runtime entrypoint',
      satisfied: entryRead,
    },
    {
      id: 'project-tests',
      description: 'Inspect representative tests when the project contains tests',
      satisfied: testRead,
    },
  ]
  const missing = criteria.filter((criterion) => !criterion.satisfied).map((criterion) => criterion.description)
  return {
    complete: missing.length === 0,
    criteria,
    missing,
    filesRead: readCount,
    targetReadCount: profile.targetReadCount,
  }
}

function sourceArea(file: string): string | null {
  const parts = file.split('/')
  if (!SOURCE_ROOTS.has(parts[0] ?? '')) return null
  if (parts[0] === 'packages' || parts[0] === 'apps') return parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0]
  return parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0]
}

function normalizeReadPath(cwd: string, file: string): string {
  const absolute = resolve(cwd, file)
  const normalized = relative(cwd, absolute).split(sep).join('/')
  return normalized.startsWith('../') ? file.split(sep).join('/') : normalized
}
