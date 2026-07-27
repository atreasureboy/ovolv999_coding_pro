import { execFileSync } from 'node:child_process'

const npmCli = process.env.npm_execpath
if (!npmCli) {
  throw new Error('npm_execpath is unavailable; run package verification through npm')
}
const output = execFileSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
  encoding: 'utf8',
})
const [pack] = JSON.parse(output)
const paths = pack.files.map((file) => file.path)
for (const required of ['dist/bin/ovogogogo.js', 'dist/package.json']) {
  if (!paths.includes(required)) {
    throw new Error(`npm package is missing ${required}`)
  }
}
for (const path of paths) {
  if (path.startsWith('tests/') || path.startsWith('src/')) {
    throw new Error(`npm package contains development source: ${path}`)
  }
}
process.stdout.write(`verified ${pack.entryCount} npm package files\n`)
