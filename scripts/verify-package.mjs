import { execFileSync } from 'node:child_process'

const packageManagerCli = process.env.npm_execpath
if (!packageManagerCli) {
  throw new Error('package manager executable is unavailable; run package verification through pnpm')
}
const output = execFileSync(process.execPath, [packageManagerCli, '--config.ignore-scripts=true', 'pack', '--dry-run', '--json'], {
  encoding: 'utf8',
})
const parsed = JSON.parse(output)
const pack = Array.isArray(parsed) ? parsed[0] : parsed
const paths = pack.files.map((file) => file.path)
for (const required of ['dist/bin/ovogogogo.js', 'dist/package.json']) {
  if (!paths.includes(required)) {
    throw new Error(`published package is missing ${required}`)
  }
}
for (const path of paths) {
  if (path.startsWith('tests/') || path.startsWith('src/') || path.includes('/__tests__/')) {
    throw new Error(`published package contains development source: ${path}`)
  }
}
process.stdout.write(`verified ${paths.length} published package files\n`)
