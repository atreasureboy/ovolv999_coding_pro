import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')

describe('quick-start scripts', () => {
  it('copies package metadata into dist and makes the CLI executable', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: { build: string } }
    expect(pkg.scripts.build).toContain("copyFileSync('package.json','dist/package.json')")
    expect(pkg.scripts.build).toContain("chmodSync('dist/bin/ovogogogo.js',0o755)")
  })

  it('uses npm for a clean Unix cold start and never parses .env in shell', () => {
    const script = read('start.sh')
    expect(script).toContain('npm ci --no-audit --no-fund')
    expect(script).toContain('npm run build')
    expect(script).toContain('find bin src -type f -newer "$ENTRY"')
    expect(script).not.toContain('OPENAI_API_KEY')
    expect(script).not.toContain('xargs')
  })

  it('keeps local setup executable and verifies the built command', () => {
    const mode = statSync(resolve(root, 'setup.sh')).mode
    expect(mode & 0o111).not.toBe(0)
    expect(read('setup.sh')).toContain('"$ENTRY" --version')
    expect(read('setup.bat')).toContain('node "%PROJECT_DIR%\\dist\\bin\\ovogogogo.js" --version')
  })

  it('requires native command success in both installers', () => {
    const unix = read('install.sh')
    const windows = read('install.ps1')
    expect(unix).toContain('"$ENTRY" --version >/dev/null')
    expect(windows).toContain('if ($LASTEXITCODE -ne 0) { Die "build failed." }')
    expect(windows).toContain('if ($LASTEXITCODE -ne 0) { Die "built CLI failed its version smoke test." }')
  })

  it('documents the actual checkout directory', () => {
    expect(read('README.md')).toContain('cd ovolv999_coding_pro')
    expect(read('README.md')).not.toContain('cd ovolv999_coding\n')
  })
})
