/**
 * File State Cache — tracks which files have been Read this session.
 * Edit/Write tools check this to enforce "read before edit" (like Claude Code).
 */

import { resolve } from 'path'

const _readFiles = new Set<string>()

export function markFileRead(filePath: string): void {
  _readFiles.add(resolve(filePath))
}

export function hasFileBeenRead(filePath: string): boolean {
  return _readFiles.has(resolve(filePath))
}

export function clearFileState(): void {
  _readFiles.clear()
}
