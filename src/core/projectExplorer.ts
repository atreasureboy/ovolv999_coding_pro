/**
 * ProjectExplorer — auto-discovers project structure, languages, frameworks,
 * entry points, and build systems. No external dependencies.
 *
 * Inspired by Codex's project analysis and Claude Code's repo map.
 * Provides the agent with a structured overview of the codebase so it
 * can make better decisions about which files to read/modify.
 */

import { existsSync, readFileSync, readdirSync } from 'fs'
import { join, extname } from 'path'

export interface LanguageInfo {
  name: string
  extensions: string[]
  fileCount: number
  percentage: number
}

export interface FrameworkInfo {
  name: string
  detectedBy: string
  confidence: 'high' | 'medium' | 'low'
}

export interface BuildSystem {
  name: string
  configFile: string
  commands: Record<string, string>
}

export interface ProjectOverview {
  rootDir: string
  name: string
  totalFiles: number
  totalDirs: number
  languages: LanguageInfo[]
  frameworks: FrameworkInfo[]
  buildSystem: BuildSystem | null
  packageManager: string | null
  entryPoints: string[]
  configFiles: string[]
  hasTests: boolean
  hasGit: boolean
  hasCI: boolean
  repoType: 'monorepo' | 'single-package' | 'unknown'
}

// ── Framework detectors ─────────────────────────────────────────────────────

interface Detector {
  check: (cwd: string, pkgJson: Record<string, unknown> | null) => FrameworkInfo | null
}

const FRAMEWORK_DETECTORS: Detector[] = [
  {
    check: (_cwd, pkg) => {
      if (pkg?.dependencies && typeof pkg.dependencies === 'object') {
        const deps = pkg.dependencies as Record<string, string>
        if ('next' in deps) return { name: 'Next.js', detectedBy: 'package.json dependencies.next', confidence: 'high' }
        if ('react' in deps && !('next' in deps)) return { name: 'React', detectedBy: 'package.json dependencies.react', confidence: 'high' }
        if ('vue' in deps) return { name: 'Vue.js', detectedBy: 'package.json dependencies.vue', confidence: 'high' }
        if ('svelte' in deps) return { name: 'Svelte', detectedBy: 'package.json dependencies.svelte', confidence: 'high' }
        if ('@angular/core' in deps) return { name: 'Angular', detectedBy: 'package.json dependencies.@angular/core', confidence: 'high' }
        if ('express' in deps) return { name: 'Express', detectedBy: 'package.json dependencies.express', confidence: 'high' }
        if ('fastify' in deps) return { name: 'Fastify', detectedBy: 'package.json dependencies.fastify', confidence: 'high' }
        if ('prisma' in deps) return { name: 'Prisma', detectedBy: 'package.json dependencies.prisma', confidence: 'high' }
        if ('drizzle-orm' in deps) return { name: 'Drizzle', detectedBy: 'package.json dependencies.drizzle-orm', confidence: 'high' }
        if ('tailwindcss' in deps) return { name: 'Tailwind CSS', detectedBy: 'package.json dependencies.tailwindcss', confidence: 'high' }
        if ('vitest' in deps) return { name: 'Vitest', detectedBy: 'package.json dependencies.vitest', confidence: 'high' }
        if ('jest' in deps) return { name: 'Jest', detectedBy: 'package.json dependencies.jest', confidence: 'medium' }
        if ('eslint' in deps) return { name: 'ESLint', detectedBy: 'package.json dependencies.eslint', confidence: 'medium' }
      }
      return null
    },
  },
]

// ── Language extensions ─────────────────────────────────────────────────────

const LANGUAGE_EXTENSIONS: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript React',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript React',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.swift': 'Swift',
  '.c': 'C',
  '.cpp': 'C++',
  '.h': 'C/C++ Header',
  '.hpp': 'C++ Header',
  '.cs': 'C#',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.scala': 'Scala',
  '.clj': 'Clojure',
  '.ex': 'Elixir',
  '.exs': 'Elixir Script',
  '.dart': 'Dart',
  '.r': 'R',
  '.lua': 'Lua',
  '.zig': 'Zig',
  '.nim': 'Nim',
  '.ml': 'OCaml',
  '.mli': 'OCaml Interface',
  '.hs': 'Haskell',
  '.elm': 'Elm',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
  '.astro': 'Astro',
  '.md': 'Markdown',
  '.mdx': 'MDX',
  '.json': 'JSON',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.toml': 'TOML',
  '.xml': 'XML',
  '.css': 'CSS',
  '.scss': 'SCSS',
  '.less': 'Less',
  '.html': 'HTML',
  '.sql': 'SQL',
  '.graphql': 'GraphQL',
  '.proto': 'Protobuf',
  '.sh': 'Shell',
  '.bash': 'Bash',
  '.ps1': 'PowerShell',
  '.dockerfile': 'Dockerfile',
  '.tf': 'Terraform',
  '.hcl': 'HCL',
}

// ── Build system detectors ──────────────────────────────────────────────────

function detectBuildSystem(cwd: string): BuildSystem | null {
  if (existsSync(join(cwd, 'tsconfig.json'))) {
    return {
      name: 'TypeScript Compiler',
      configFile: 'tsconfig.json',
      commands: { build: 'tsc', watch: 'tsc --watch', typecheck: 'tsc --noEmit' },
    }
  }
  if (existsSync(join(cwd, 'Makefile'))) {
    return { name: 'Make', configFile: 'Makefile', commands: { build: 'make', test: 'make test', clean: 'make clean' } }
  }
  if (existsSync(join(cwd, 'CMakeLists.txt'))) {
    return { name: 'CMake', configFile: 'CMakeLists.txt', commands: { build: 'cmake --build .', test: 'ctest' } }
  }
  if (existsSync(join(cwd, 'Cargo.toml'))) {
    return { name: 'Cargo', configFile: 'Cargo.toml', commands: { build: 'cargo build', test: 'cargo test', check: 'cargo check' } }
  }
  if (existsSync(join(cwd, 'go.mod'))) {
    return { name: 'Go Modules', configFile: 'go.mod', commands: { build: 'go build ./...', test: 'go test ./...' } }
  }
  return null
}

function detectPackageManager(cwd: string): string | null {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(cwd, 'package-lock.json'))) return 'npm'
  if (existsSync(join(cwd, 'bun.lockb'))) return 'bun'
  // v0.6.0 (audit): a package.json without a lockfile still indicates
  // an npm-style project — report it rather than null so callers can
  // act on it.
  if (existsSync(join(cwd, 'package.json'))) return 'npm'
  return null
}

function detectConfigFiles(cwd: string): string[] {
  const patterns = [
    'tsconfig.json', 'tsconfig.build.json', 'eslint.config.js', 'eslint.config.mjs',
    '.eslintrc.js', '.eslintrc.json', '.prettierrc', 'prettier.config.js',
    '.editorconfig', '.gitignore', '.dockerignore', 'Dockerfile',
    'docker-compose.yml', 'docker-compose.yaml', '.github/workflows',
    '.gitlab-ci.yml', 'Jenkinsfile', 'Makefile', 'biome.json',
    'vitest.config.ts', 'vitest.config.js', 'jest.config.js', 'jest.config.ts',
    'tailwind.config.js', 'tailwind.config.ts', 'postcss.config.js',
    'next.config.js', 'next.config.ts', 'nuxt.config.ts', 'svelte.config.js',
    'astro.config.mjs', 'vite.config.ts', 'vite.config.js',
    '.env.example', '.env.sample', '.env.template',
  ]
  return patterns.filter(p => existsSync(join(cwd, p)))
}

function detectEntryPoints(cwd: string, pkgJson: Record<string, unknown> | null): string[] {
  const entries: string[] = []

  if (pkgJson) {
    const main = pkgJson.main as string | undefined
    if (main) entries.push(main)
    const bin = pkgJson.bin as string | Record<string, string> | undefined
    if (typeof bin === 'string') entries.push(bin)
    else if (bin && typeof bin === 'object') {
      for (const v of Object.values(bin)) entries.push(v)
    }
  }

  // Common entry point patterns
  const entryPatterns = [
    'src/index.ts', 'src/index.tsx', 'src/main.ts', 'src/main.tsx',
    'src/app.ts', 'src/app.tsx', 'src/server.ts', 'src/cli.ts',
    'bin/cli.ts', 'bin/index.ts', 'bin/ovogogogo.ts',
    'main.go', 'main.py', 'main.rs', 'src/main.rs',
  ]
  for (const p of entryPatterns) {
    if (existsSync(join(cwd, p)) && !entries.includes(p)) {
      entries.push(p)
    }
  }

  return entries
}

// ── Recursive scan ──────────────────────────────────────────────────────────

function scanDirectory(
  cwd: string,
  maxDepth: number,
  currentDepth: number,
  langCount: Map<string, number>,
  totalFiles: { count: number },
  totalDirs: { count: number },
  excludedDirs: Set<string>,
): void {
  if (currentDepth > maxDepth) return

  let entries
  try {
    entries = readdirSync(cwd, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      if (entry.name === '.git' || entry.name === '.github') {
        if (entry.isDirectory()) totalDirs.count++
        continue
      }
    }

    if (entry.isDirectory()) {
      if (excludedDirs.has(entry.name)) {
        totalDirs.count++
        continue
      }
      totalDirs.count++
      scanDirectory(join(cwd, entry.name), maxDepth, currentDepth + 1, langCount, totalFiles, totalDirs, excludedDirs)
    } else if (entry.isFile()) {
      totalFiles.count++
      const ext = extname(entry.name).toLowerCase()
      if (ext) {
        langCount.set(ext, (langCount.get(ext) ?? 0) + 1)
      } else {
        // Handle files without extensions
        const name = entry.name.toLowerCase()
        const extMap: Record<string, string> = {
          'dockerfile': '.dockerfile',
          'makefile': '.makefile',
          '.gitignore': '.gitignore',
        }
        for (const [key, mapped] of Object.entries(extMap)) {
          if (name === key) {
            langCount.set(mapped, (langCount.get(mapped) ?? 0) + 1)
            break
          }
        }
      }
    }
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export function exploreProject(cwd: string = process.cwd()): ProjectOverview {
  const excludedDirs = new Set([
    'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
    '__pycache__', '.cache', 'vendor', 'target', '.turbo',
    '.vercel', '.svelte-kit', '.nuxt', '.output',
  ])

  const langCount = new Map<string, number>()
  const totalFiles = { count: 0 }
  const totalDirs = { count: 0 }

  scanDirectory(cwd, 10, 0, langCount, totalFiles, totalDirs, excludedDirs)

  // Sort languages by file count
  const sorted = [...langCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)

  const total = sorted.reduce((s, [, c]) => s + c, 0)
  const languages: LanguageInfo[] = sorted.map(([ext, count]) => ({
    name: LANGUAGE_EXTENSIONS[ext] ?? ext,
    extensions: [ext],
    fileCount: count,
    percentage: total > 0 ? Math.round((count / total) * 100) : 0,
  }))

  // Read package.json
  let pkgJson: Record<string, unknown> | null = null
  const pkgPath = join(cwd, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      pkgJson = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
    } catch { /* ignore */ }
  }

  // Detect frameworks
  const frameworks = FRAMEWORK_DETECTORS
    .map(d => d.check(cwd, pkgJson))
    .filter((f): f is FrameworkInfo => f !== null)

  // Detect build system
  const buildSystem = detectBuildSystem(cwd)

  // Detect package manager
  const packageManager = detectPackageManager(cwd)

  // Detect entry points
  const entryPoints = detectEntryPoints(cwd, pkgJson)

  // Detect config files
  const configFiles = detectConfigFiles(cwd)

  // Detect monorepo
  const hasWorkspaces = pkgJson?.workspaces !== undefined
  const hasPnpmWorkspace = existsSync(join(cwd, 'pnpm-workspace.yaml'))
  const hasNxWorkspace = existsSync(join(cwd, 'nx.json'))
  const hasTurbo = existsSync(join(cwd, 'turbo.json'))
  const hasLerna = existsSync(join(cwd, 'lerna.json'))
  const repoType = (hasWorkspaces || hasPnpmWorkspace || hasNxWorkspace || hasTurbo || hasLerna)
    ? 'monorepo'
    : 'single-package'

  // Detect tests
  const hasTests = existsSync(join(cwd, 'tests')) || existsSync(join(cwd, '__tests__'))

  // Detect git
  const hasGit = existsSync(join(cwd, '.git'))

  // Detect CI
  const hasCI = existsSync(join(cwd, '.github', 'workflows')) ||
    existsSync(join(cwd, '.gitlab-ci.yml')) ||
    existsSync(join(cwd, 'Jenkinsfile'))

  const name = pkgJson?.name as string ?? cwd.split(/[\\/]/).pop() ?? 'unknown'

  return {
    rootDir: cwd,
    name,
    totalFiles: totalFiles.count,
    totalDirs: totalDirs.count,
    languages,
    frameworks,
    buildSystem,
    packageManager,
    entryPoints,
    configFiles,
    hasTests,
    hasGit,
    hasCI,
    repoType,
  }
}

export function formatProjectOverview(overview: ProjectOverview): string {
  const lines: string[] = []
  lines.push(`# Project Overview: ${overview.name}`)
  lines.push(`Root: ${overview.rootDir}`)
  lines.push(`Files: ${overview.totalFiles} | Dirs: ${overview.totalDirs} | Type: ${overview.repoType}`)
  lines.push(`Git: ${overview.hasGit ? 'yes' : 'no'} | CI: ${overview.hasCI ? 'yes' : 'no'} | Tests: ${overview.hasTests ? 'yes' : 'no'}`)

  if (overview.languages.length > 0) {
    lines.push('\n## Languages')
    for (const lang of overview.languages) {
      lines.push(`  ${lang.name}: ${lang.fileCount} files (${lang.percentage}%)`)
    }
  }

  if (overview.frameworks.length > 0) {
    lines.push('\n## Frameworks & Libraries')
    for (const fw of overview.frameworks) {
      lines.push(`  ${fw.name} (${fw.confidence}) — detected by ${fw.detectedBy}`)
    }
  }

  if (overview.buildSystem) {
    lines.push('\n## Build System')
    lines.push(`  ${overview.buildSystem.name} (${overview.buildSystem.configFile})`)
    for (const [cmd, val] of Object.entries(overview.buildSystem.commands)) {
      lines.push(`  ${cmd}: ${val}`)
    }
  }

  if (overview.packageManager) {
    lines.push(`\n## Package Manager: ${overview.packageManager}`)
  }

  if (overview.entryPoints.length > 0) {
    lines.push('\n## Entry Points')
    for (const ep of overview.entryPoints) {
      lines.push(`  ${ep}`)
    }
  }

  if (overview.configFiles.length > 0) {
    lines.push('\n## Config Files')
    for (const cf of overview.configFiles.slice(0, 15)) {
      lines.push(`  ${cf}`)
    }
    if (overview.configFiles.length > 15) {
      lines.push(`  ... and ${overview.configFiles.length - 15} more`)
    }
  }

  return lines.join('\n')
}