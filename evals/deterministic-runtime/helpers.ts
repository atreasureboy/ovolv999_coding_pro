/**
 * Helpers for deterministic-runtime evals.
 */
import * as fs from 'fs'
import * as path from 'path'

/**
 * Compile-time + runtime check that every requested RunEvent type
 * is present in the RunEvent union. Reads the source file (no
 * runtime import — vitest can run this in a fast check phase) and
 * scans for `'TYPE_NAME'` declarations.
 */
export function runEventTypesExist(types: string[]): boolean {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../src/core/runtime/events.ts'),
    'utf8',
  )
  return types.every((t) => new RegExp(`'${t}'`).test(src))
}