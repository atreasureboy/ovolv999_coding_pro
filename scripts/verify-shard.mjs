#!/usr/bin/env node
/**
 * CI self-test: verify vitest sharding actually splits the test suite.
 *
 * Regressions (like `pnpm test -- --shard=...` silently running all tests)
 * are caught by this check: each shard must contain fewer unique test files
 * than 90% of the total. Uses `vitest list` (no test execution), so it is
 * cheap enough to run on every CI validate job.
 */
import { execSync } from 'node:child_process'

const shardIndex = parseInt(process.argv[2], 10)
const shardTotal = parseInt(process.argv[3], 10)

function uniqueFiles(output) {
  const files = new Set()
  for (const line of output.split('\n')) {
    const m = line.match(/([^\s>]+\.test\.ts)/)
    if (m) files.add(m[1])
  }
  return files
}

try {
  const totalOut = execSync('pnpm exec vitest list 2>&1', { encoding: 'utf8' })
  const total = uniqueFiles(totalOut).size
  const maxShardFiles = Math.floor(total * 0.9)

  const shardOut = execSync(
    `pnpm exec vitest list --shard=${shardIndex}/${shardTotal} 2>&1`,
    { encoding: 'utf8' },
  )
  const count = uniqueFiles(shardOut).size

  console.log(`Total test files: ${total}`)
  console.log(`Shard ${shardIndex}/${shardTotal}: ${count} unique test files`)

  if (count === 0) {
    console.error('ERROR: shard contains 0 test files — sharding may be broken')
    process.exit(1)
  }

  if (count >= maxShardFiles) {
    console.error(
      `ERROR: shard contains ${count} files (>= ${maxShardFiles} threshold) — sharding is NOT working`,
    )
    process.exit(1)
  }

  console.log(`OK: ${count} < ${maxShardFiles} threshold`)
} catch (err) {
  console.error('Failed to run shard verification:', err)
  process.exit(1)
}
