/**
 * Project Onboarding
 *
 * Generates a comprehensive overview of a project for onboarding:
 * - Structure (directories, key files)
 * - Dependencies (package.json, requirements.txt, etc.)
 * - Scripts/commands
 * - Test setup
 * - Git state
 * - Code statistics
 * - Conventions detected
 *
 * Output is formatted as markdown for easy reading.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, resolve, extname, basename, relative } from 'path'
import { execSync } from 'child_process'

// ── Types ───────────────────────────────────────────────────────────────────

export interface ProjectOverview {
  name: string
  version: string
  description: string
  language: string
  framework: string | null
  rootDir: string
  structure: DirectoryNode
  dependencies: DependencyInfo
  scripts: Record<string, string>
  testSetup: TestSetup
  gitState: GitInfo | null
  stats: CodeStats
  conventions: string[]
  keyFiles: string[]
  buildSystem: string | null
  license: string | null
}

export interface DirectoryNode {
  name: string
  path: string
  type: 'directory' | 'file'
  children?: DirectoryNode[]
  size?: number
}

export interface DependencyInfo {
  type: 'npm' | 'pip' | 'cargo' | 'go' | 'gem' | 'none'
  production: Record<string, string>
  development: Record<string, string>
  totalCount: number
}

export interface TestSetup {
  framework: string | null
  configFile: string | null
  testDir: string | null
  testFileCount: number
  hasTests: boolean
}

export interface GitInfo {
  branch: string
  isClean: boolean
  modifiedCount: number
  remoteUrl: string | null
  lastCommit: string | null
  lastCommitDate: string | null
}

export interface CodeStats {
  totalFiles: number
  totalLines: number
  filesByExtension: Record<string, number>
  linesByExtension: Record<string, number>
  largestFiles: Array<{ path: string; lines: number }>
}

// ── Analysis ────────────────────────────────────────────────────────────────

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
  '.cache', '.turbo', 'coverage', '.nyc_output', '.pytest_cache',
  '.venv', 'venv', 'env', '.idea', '.vscode', 'target',
])

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.rb', '.go', '.rs', '.java',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.php', '.swift', '.kt',
  '.scala', '.sh', '.sql', '.html', '.css', '.scss', '.vue', '.svelte',
])

const MAX_DEPTH = 3
const MAX_FILES = 500

export function analyzeProject(rootDir: string): ProjectOverview {
  const root = resolve(rootDir)

  const pkg = readPackageJson(root)
  const structure = buildStructure(root, root, 0)
  const dependencies = analyzeDependencies(root)
  const scripts = pkg?.scripts ?? {}
  const testSetup = analyzeTestSetup(root, pkg)
  const gitState = analyzeGit(root)
  const stats = computeStats(root)
  const conventions = detectConventions(root, pkg)
  const keyFiles = findKeyFiles(root)
  const buildSystem = detectBuildSystem(root, pkg)
  const license = detectLicense(root)

  return {
    name: pkg?.name ?? basename(root),
    version: pkg?.version ?? '0.0.0',
    description: pkg?.description ?? '',
    language: detectPrimaryLanguage(stats),
    framework: detectFramework(pkg, dependencies),
    rootDir: root,
    structure,
    dependencies,
    scripts,
    testSetup,
    gitState,
    stats,
    conventions,
    keyFiles,
    buildSystem,
    license,
  }
}

// ── Package.json ────────────────────────────────────────────────────────────

function readPackageJson(root: string): any {
  const path = join(root, 'package.json')
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

// ── Structure ───────────────────────────────────────────────────────────────

function buildStructure(root: string, currentDir: string, depth: number): DirectoryNode {
  const name = relative(root, currentDir) || basename(root)
  const node: DirectoryNode = {
    name: name || '.',
    path: currentDir,
    type: 'directory',
  }

  if (depth >= MAX_DEPTH) return node

  try {
    const entries = readdirSync(currentDir)
      .filter(e => !IGNORED_DIRS.has(e) && !e.startsWith('.'))
      .sort()

    const children: DirectoryNode[] = []
    for (const entry of entries) {
      const fullPath = join(currentDir, entry)
      try {
        const stat = statSync(fullPath)
        if (stat.isDirectory()) {
          children.push(buildStructure(root, fullPath, depth + 1))
        } else if (depth < 2) {
          // Only show files at shallow depths
          children.push({
            name: entry,
            path: fullPath,
            type: 'file',
            size: stat.size,
          })
        }
      } catch { /* skip */ }
      if (children.length >= 50) break
    }
    if (children.length > 0) node.children = children
  } catch { /* skip */ }

  return node
}

// ── Dependencies ────────────────────────────────────────────────────────────

function analyzeDependencies(root: string): DependencyInfo {
  // npm/package.json
  const pkg = readPackageJson(root)
  if (pkg) {
    const production = pkg.dependencies ?? {}
    const development = pkg.devDependencies ?? {}
    return {
      type: 'npm',
      production,
      development,
      totalCount: Object.keys(production).length + Object.keys(development).length,
    }
  }

  // Python
  const reqPath = join(root, 'requirements.txt')
  if (existsSync(reqPath)) {
    try {
      const lines = readFileSync(reqPath, 'utf8').split('\n').filter(l => l.trim() && !l.startsWith('#'))
      const deps: Record<string, string> = {}
      for (const line of lines) {
        const [name, version] = line.split(/[=<>]/)
        deps[name.trim()] = version?.trim() ?? '*'
      }
      return { type: 'pip', production: deps, development: {}, totalCount: lines.length }
    } catch { /* skip */ }
  }

  // Cargo (Rust)
  const cargoPath = join(root, 'Cargo.toml')
  if (existsSync(cargoPath)) {
    return { type: 'cargo', production: {}, development: {}, totalCount: 0 }
  }

  // Go
  const goPath = join(root, 'go.mod')
  if (existsSync(goPath)) {
    return { type: 'go', production: {}, development: {}, totalCount: 0 }
  }

  // Ruby
  const gemPath = join(root, 'Gemfile')
  if (existsSync(gemPath)) {
    return { type: 'gem', production: {}, development: {}, totalCount: 0 }
  }

  return { type: 'none', production: {}, development: {}, totalCount: 0 }
}

// ── Test Setup ──────────────────────────────────────────────────────────────

function analyzeTestSetup(root: string, pkg: any): TestSetup {
  // Check for test frameworks in package.json
  if (pkg) {
    const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    if (allDeps.vitest) {
      return makeTestResult('vitest', root, 'vitest.config.ts')
    }
    if (allDeps.jest) {
      return makeTestResult('jest', root, 'jest.config.js')
    }
    if (allDeps.mocha) {
      return makeTestResult('mocha', root, '.mocharc')
    }
    if (allDeps.pytest) {
      return makeTestResult('pytest', root, 'pytest.ini')
    }
  }

  // Check for test directories
  for (const dir of ['tests', 'test', '__tests__', 'spec']) {
    if (existsSync(join(root, dir))) {
      return makeTestResult(null, root, null, dir)
    }
  }

  return { framework: null, configFile: null, testDir: null, testFileCount: 0, hasTests: false }
}

function makeTestResult(framework: string | null, root: string, configFile: string | null, testDir?: string): TestSetup {
  const dir = testDir ?? 'tests'
  const testPath = join(root, dir)
  let testFileCount = 0
  if (existsSync(testPath)) {
    try {
      testFileCount = countTestFiles(testPath)
    } catch { /* skip */ }
  }
  const configPath = configFile ? join(root, configFile) : null
  return {
    framework,
    configFile: configPath && existsSync(configPath) ? configPath : null,
    testDir: existsSync(testPath) ? testPath : null,
    testFileCount,
    hasTests: testFileCount > 0 || framework !== null,
  }
}

function countTestFiles(dir: string): number {
  let count = 0
  try {
    const entries = readdirSync(dir)
    for (const entry of entries) {
      const fullPath = join(dir, entry)
      const stat = statSync(fullPath)
      if (stat.isDirectory()) {
        if (!IGNORED_DIRS.has(entry)) count += countTestFiles(fullPath)
      } else if (entry.includes('.test.') || entry.includes('.spec.') || entry.startsWith('test_') || entry.endsWith('_test.py')) {
        count++
      }
    }
  } catch { /* skip */ }
  return count
}

// ── Git ─────────────────────────────────────────────────────────────────────

function analyzeGit(root: string): GitInfo | null {
  try {
    const run = (cmd: string): string =>
      execSync(cmd, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()

    const branch = run('git rev-parse --abbrev-ref HEAD')
    const status = run('git status --porcelain=v1')
    const modifiedCount = status.split('\n').filter(Boolean).length

    let remoteUrl: string | null = null
    try { remoteUrl = run('git remote get-url origin') } catch { /* no remote */ }

    let lastCommit: string | null = null
    let lastCommitDate: string | null = null
    try {
      lastCommit = run('git log -1 --format=%s')
      lastCommitDate = run('git log -1 --format=%ci')
    } catch { /* no commits */ }

    return {
      branch,
      isClean: modifiedCount === 0,
      modifiedCount,
      remoteUrl,
      lastCommit,
      lastCommitDate,
    }
  } catch {
    return null
  }
}

// ── Code Stats ──────────────────────────────────────────────────────────────

function computeStats(root: string): CodeStats {
  const stats: CodeStats = {
    totalFiles: 0,
    totalLines: 0,
    filesByExtension: {},
    linesByExtension: {},
    largestFiles: [],
  }

  const allFiles: Array<{ path: string; lines: number }> = []

  function walk(dir: string) {
    if (stats.totalFiles >= MAX_FILES) return
    try {
      const entries = readdirSync(dir)
      for (const entry of entries) {
        if (IGNORED_DIRS.has(entry) || entry.startsWith('.')) continue
        const fullPath = join(dir, entry)
        try {
          const stat = statSync(fullPath)
          if (stat.isDirectory()) {
            walk(fullPath)
          } else {
            const ext = extname(entry).toLowerCase()
            if (!CODE_EXTENSIONS.has(ext)) continue
            stats.totalFiles++
            stats.filesByExtension[ext] = (stats.filesByExtension[ext] ?? 0) + 1
            try {
              const content = readFileSync(fullPath, 'utf8')
              const lines = content.split('\n').length
              stats.totalLines += lines
              stats.linesByExtension[ext] = (stats.linesByExtension[ext] ?? 0) + lines
              allFiles.push({ path: relative(root, fullPath), lines })
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  walk(root)

  // Top 10 largest files
  stats.largestFiles = allFiles
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 10)

  return stats
}

// ── Detection ───────────────────────────────────────────────────────────────

function detectPrimaryLanguage(stats: CodeStats): string {
  const sorted = Object.entries(stats.linesByExtension)
    .sort((a, b) => b[1] - a[1])
  if (sorted.length === 0) return 'Unknown'
  const ext = sorted[0][0]
  const map: Record<string, string> = {
    '.ts': 'TypeScript', '.tsx': 'TypeScript',
    '.js': 'JavaScript', '.jsx': 'JavaScript',
    '.py': 'Python', '.go': 'Go', '.rs': 'Rust',
    '.java': 'Java', '.rb': 'Ruby', '.php': 'PHP',
    '.cs': 'C#', '.cpp': 'C++', '.c': 'C',
  }
  return map[ext] ?? 'Unknown'
}

function detectFramework(pkg: any, deps: DependencyInfo): string | null {
  if (!pkg) return null
  const all = { ...deps.production, ...deps.development }
  if (all.react) return 'React'
  if (all.vue) return 'Vue'
  if (all.express) return 'Express'
  if (all.next) return 'Next.js'
  if (all.fastapi) return 'FastAPI'
  if (all.django) return 'Django'
  if (all.flask) return 'Flask'
  return null
}

function detectConventions(root: string, pkg: any): string[] {
  const conventions: string[] = []

  if (existsSync(join(root, '.editorconfig'))) conventions.push('EditorConfig defined')
  if (existsSync(join(root, '.prettierrc')) || pkg?.devDependencies?.prettie) conventions.push('Prettier formatting')
  if (existsSync(join(root, '.eslintrc')) || existsSync(join(root, '.eslintrc.json')) || pkg?.devDependencies?.eslint) conventions.push('ESLint configured')
  if (existsSync(join(root, 'tsconfig.json'))) conventions.push('TypeScript strict typing')
  if (existsSync(join(root, '.ovolv999')) || existsSync(join(root, '.ovogo'))) conventions.push('ovolv999 configured')
  if (existsSync(join(root, 'AGENTS.md'))) conventions.push('AGENTS.md instructions')
  if (existsSync(join(root, '.pre-commit-config.yaml'))) conventions.push('pre-commit hooks')
  if (existsSync(join(root, '.github/workflows'))) conventions.push('CI/CD via GitHub Actions')

  // Check for common patterns
  if (existsSync(join(root, 'docker-compose.yml')) || existsSync(join(root, 'Dockerfile'))) {
    conventions.push('Docker containerization')
  }

  return conventions
}

function findKeyFiles(root: string): string[] {
  const keyFiles = [
    'package.json', 'tsconfig.json', 'README.md', 'AGENTS.md',
    '.env.example', 'docker-compose.yml', 'Dockerfile',
    'Makefile', 'Cargo.toml', 'go.mod', 'requirements.txt',
    'pyproject.toml', '.eslintrc', '.prettierrc',
  ]
  return keyFiles.filter(f => existsSync(join(root, f)))
}

function detectBuildSystem(root: string, pkg: any): string | null {
  if (pkg?.scripts?.build) return 'npm build'
  if (existsSync(join(root, 'Makefile'))) return 'make'
  if (existsSync(join(root, 'webpack.config.js'))) return 'webpack'
  if (existsSync(join(root, 'vite.config.ts')) || existsSync(join(root, 'vite.config.js'))) return 'vite'
  if (existsSync(join(root, 'Cargo.toml'))) return 'cargo'
  if (existsSync(join(root, 'go.mod'))) return 'go build'
  return null
}

function detectLicense(root: string): string | null {
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING']) {
    const path = join(root, name)
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, 'utf8').slice(0, 500).toLowerCase()
        if (content.includes('mit license')) return 'MIT'
        if (content.includes('apache license')) return 'Apache-2.0'
        if (content.includes('bsd license')) return 'BSD'
        if (content.includes('gnu general public license')) return 'GPL'
        return 'Custom (see LICENSE file)'
      } catch { /* skip */ }
    }
  }
  return null
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatOverview(overview: ProjectOverview): string {
  const lines: string[] = []

  lines.push(`# Project Overview: ${overview.name}`)
  lines.push('')
  lines.push(`**Version:** ${overview.version}`)
  if (overview.description) lines.push(`**Description:** ${overview.description}`)
  lines.push(`**Language:** ${overview.language}`)
  if (overview.framework) lines.push(`**Framework:** ${overview.framework}`)
  if (overview.license) lines.push(`**License:** ${overview.license}`)
  if (overview.buildSystem) lines.push(`**Build:** ${overview.buildSystem}`)
  lines.push('')

  // Structure
  lines.push('## Structure')
  lines.push('```')
  lines.push(formatTree(overview.structure, '', true))
  lines.push('```')
  lines.push('')

  // Stats
  lines.push('## Statistics')
  lines.push(`- Total code files: ${overview.stats.totalFiles}`)
  lines.push(`- Total lines: ${overview.stats.totalLines.toLocaleString()}`)
  const topLangs = Object.entries(overview.stats.linesByExtension)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
  if (topLangs.length > 0) {
    lines.push('- By extension:')
    for (const [ext, lines_] of topLangs) {
      lines.push(`  - ${ext}: ${lines_.toLocaleString()} lines`)
    }
  }
  if (overview.stats.largestFiles.length > 0) {
    lines.push('- Largest files:')
    for (const f of overview.stats.largestFiles.slice(0, 5)) {
      lines.push(`  - ${f.path}: ${f.lines} lines`)
    }
  }
  lines.push('')

  // Dependencies
  if (overview.dependencies.totalCount > 0) {
    lines.push(`## Dependencies (${overview.dependencies.type})`)
    if (Object.keys(overview.dependencies.production).length > 0) {
      lines.push('**Production:**')
      const prod = Object.entries(overview.dependencies.production).slice(0, 15)
      for (const [name, version] of prod) {
        lines.push(`- ${name}: ${version}`)
      }
    }
    if (Object.keys(overview.dependencies.development).length > 0) {
      lines.push('**Development:**')
      const dev = Object.entries(overview.dependencies.development).slice(0, 10)
      for (const [name, version] of dev) {
        lines.push(`- ${name}: ${version}`)
      }
    }
    lines.push('')
  }

  // Scripts
  if (Object.keys(overview.scripts).length > 0) {
    lines.push('## Scripts')
    for (const [name, cmd] of Object.entries(overview.scripts).slice(0, 10)) {
      lines.push(`- \`${name}\`: ${cmd.slice(0, 80)}`)
    }
    lines.push('')
  }

  // Testing
  lines.push('## Testing')
  if (overview.testSetup.framework) {
    lines.push(`- Framework: ${overview.testSetup.framework}`)
  }
  if (overview.testSetup.configFile) {
    lines.push(`- Config: ${overview.testSetup.configFile}`)
  }
  if (overview.testSetup.testDir) {
    lines.push(`- Test directory: ${overview.testSetup.testDir}`)
    lines.push(`- Test files: ${overview.testSetup.testFileCount}`)
  }
  if (!overview.testSetup.hasTests) {
    lines.push('- No test setup detected')
  }
  lines.push('')

  // Git
  if (overview.gitState) {
    lines.push('## Git')
    lines.push(`- Branch: ${overview.gitState.branch}`)
    lines.push(`- Status: ${overview.gitState.isClean ? 'clean' : `${overview.gitState.modifiedCount} modification(s)`}`)
    if (overview.gitState.remoteUrl) {
      lines.push(`- Remote: ${overview.gitState.remoteUrl}`)
    }
    if (overview.gitState.lastCommit) {
      lines.push(`- Last commit: ${overview.gitState.lastCommit}`)
    }
    lines.push('')
  }

  // Conventions
  if (overview.conventions.length > 0) {
    lines.push('## Conventions')
    for (const conv of overview.conventions) {
      lines.push(`- ${conv}`)
    }
    lines.push('')
  }

  // Key files
  if (overview.keyFiles.length > 0) {
    lines.push('## Key Files')
    for (const f of overview.keyFiles) {
      lines.push(`- ${f}`)
    }
  }

  return lines.join('\n')
}

function formatTree(node: DirectoryNode, prefix: string, isRoot: boolean): string {
  const lines: string[] = []
  const display = isRoot ? basename(node.path) : node.name
  lines.push(`${prefix}${display}/`)

  if (!node.children) return lines.join('\n')

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]
    const isLast = i === node.children.length - 1
    const connector = isLast ? '└── ' : '├── '
    const childPrefix = prefix + (isLast ? '    ' : '│   ')

    if (child.type === 'directory') {
      lines.push(`${prefix}${connector}${child.name}/`)
      if (child.children && child.children.length > 0) {
        const subLines = formatTree(child, childPrefix, false)
        if (subLines) lines.push(subLines)
      }
    } else {
      lines.push(`${prefix}${connector}${child.name}`)
    }
  }

  return lines.join('\n')
}
