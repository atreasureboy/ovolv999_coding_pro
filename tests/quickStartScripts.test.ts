import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')

describe('quick-start scripts', () => {
  it('copies package metadata into dist and makes the CLI executable', () => {
    const pkg = JSON.parse(read('package.json')) as {
      scripts: { build: string }
      pnpm: { overrides: Record<string, string> }
    }
    expect(pkg.scripts.build).toContain("copyFileSync('package.json','dist/package.json')")
    expect(pkg.scripts.build).toContain("chmodSync('dist/bin/ovogogogo.js',0o755)")
    expect(pkg.pnpm.overrides['whatwg-url']).toBeUndefined()
    expect(pkg.pnpm.overrides.tr46).toBeUndefined()
    expect(pkg.pnpm.overrides['brace-expansion']).toBe('5.0.9')
  })

  it('uses pnpm for a clean Unix cold start and never parses .env in shell', () => {
    const script = read('start.sh')
    expect(script).toContain('corepack pnpm install --frozen-lockfile')
    expect(script).toContain('corepack pnpm build')
    expect(script).toContain('find bin src -type f -newer "$ENTRY"')
    expect(script).not.toContain('OPENAI_API_KEY')
    expect(script).not.toContain('xargs')
    expect(script).not.toContain('npm ci')
  })

  it('keeps local setup executable and verifies the built command', () => {
    if (process.platform !== 'win32') {
      const mode = statSync(resolve(root, 'setup.sh')).mode
      expect(mode & 0o111).not.toBe(0)
    }
    expect(read('setup.sh')).toContain('"$ENTRY" --version')
    expect(read('setup.bat')).toContain('node "%PROJECT_DIR%\\dist\\bin\\ovogogogo.js" --version')
  })

  it('requires native command success in both installers', () => {
    const unix = read('install.sh')
    const windows = read('install.ps1')
    expect(unix).toContain('"$STAGED_ENTRY" --version >/dev/null')
    expect(windows).toContain('if ($LASTEXITCODE -ne 0) { throw "build failed." }')
    expect(windows).toContain('Die "built CLI failed its version smoke test."')
  })

  it('builds updates in staging and preserves the previous installation on failure', () => {
    const unix = read('install.sh')
    const windows = read('install.ps1')
    expect(unix).toContain('mktemp -d "${INSTALL_DIR}.staging.XXXXXX"')
    expect(unix).toContain('corepack pnpm install --frozen-lockfile')
    expect(unix).toContain('the existing installation was not changed')
    expect(unix).not.toContain('reset --quiet --hard')
    expect(windows).toContain('$StagingDir')
    expect(windows).toContain('$BackupDir')
    expect(windows).toContain('the previous installation was restored')
    expect(windows).not.toContain('reset --quiet --hard')
  })

  it('uses one committed pnpm lockfile across every setup entrypoint', () => {
    expect(() => read('pnpm-lock.yaml')).not.toThrow()
    expect(read('install.sh')).toContain('release is missing pnpm-lock.yaml')
    expect(read('install.ps1')).toContain('release is missing pnpm-lock.yaml')
    expect(read('setup.sh')).toContain('corepack pnpm install --frozen-lockfile')
    expect(read('setup.bat')).toContain('corepack pnpm install --frozen-lockfile')
  })

  it('documents the actual checkout directory', () => {
    expect(read('README.md')).toContain('cd ovolv999_coding_pro')
    expect(read('README.md')).not.toContain('cd ovolv999_coding\n')
  })
})
