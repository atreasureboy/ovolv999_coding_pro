/**
 * File State Cache — tracks which files have been Read this session.
 * Edit/Write tools check this to enforce "read before edit" (like Claude Code).
 */

const _readFiles = new Set<string>()

export function markFileRead(filePath: string): void {
  _readFiles.add(filePath)
}

export function hasFileBeenRead(filePath: string): boolean {
  return _readFiles.has(filePath)
}

export function clearFileState(): void {
  _readFiles.clear()
}
