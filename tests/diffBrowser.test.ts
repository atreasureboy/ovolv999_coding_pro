import { describe, it, expect } from 'vitest'
import {
  parseGitDiff,
  formatFileList,
  formatFileDetail,
  formatDiffStat,
  formatBriefSummary,
  getGitDiff,
  getFullDiff,
  getFileDiff,
} from '../src/ui/diffBrowser.js'

describe('diffBrowser', () => {
  const sampleDiff = `diff --git a/src/foo.ts b/src/foo.ts
index 1234567..abcdefg 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,5 +1,7 @@
 import { x } from 'mod'
 
-function oldFunc() {
-  return 'old'
+function newFunc() {
+  return 'new'
+  // added line
 }
 
 const y = 1
@@ -10,3 +12,4 @@
 function bar() {
   return true
 }
+export { newFunc }
`

  const sampleDiffWithAdd = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+export function hello() {
+  return 'world'
+}
`

  const sampleDiffWithDelete = `diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 1234567..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export function old() {
-}
`

  const binaryDiff = `diff --git a/image.png b/image.png
index 1234567..abcdefg 100644
Binary files a/image.png and b/image.png differ
`

  describe('parseGitDiff', () => {
    it('parses a modified file', () => {
      const result = parseGitDiff(sampleDiff)
      expect(result.totalFiles).toBe(1)
      expect(result.files[0].newPath).toBe('src/foo.ts')
      expect(result.files[0].status).toBe('modified')
    })

    it('counts additions and deletions', () => {
      const result = parseGitDiff(sampleDiff)
      expect(result.files[0].additions).toBe(4)
      expect(result.files[0].deletions).toBe(2)
      expect(result.totalAdditions).toBe(4)
      expect(result.totalDeletions).toBe(2)
    })

    it('parses multiple hunks', () => {
      const result = parseGitDiff(sampleDiff)
      expect(result.files[0].hunks.length).toBe(2)
    })

    it('parses hunk headers correctly', () => {
      const result = parseGitDiff(sampleDiff)
      const hunk = result.files[0].hunks[0]
      expect(hunk.oldStart).toBe(1)
      expect(hunk.oldCount).toBe(5)
      expect(hunk.newStart).toBe(1)
      expect(hunk.newCount).toBe(7)
    })

    it('classifies diff lines', () => {
      const result = parseGitDiff(sampleDiff)
      const hunk = result.files[0].hunks[0]
      const types = hunk.lines.map(l => l.type)
      expect(types).toContain('context')
      expect(types).toContain('add')
      expect(types).toContain('remove')
    })

    it('tracks line numbers', () => {
      const result = parseGitDiff(sampleDiff)
      const hunk = result.files[0].hunks[0]
      const firstLine = hunk.lines[0]
      expect(firstLine.type).toBe('context')
      expect(firstLine.oldLineNo).toBe(1)
      expect(firstLine.newLineNo).toBe(1)
    })

    it('detects added files', () => {
      const result = parseGitDiff(sampleDiffWithAdd)
      expect(result.files[0].status).toBe('added')
      expect(result.files[0].oldPath).toBe('/dev/null')
      expect(result.files[0].additions).toBe(3)
    })

    it('detects deleted files', () => {
      const result = parseGitDiff(sampleDiffWithDelete)
      expect(result.files[0].status).toBe('deleted')
      expect(result.files[0].newPath).toBe('/dev/null')
      expect(result.files[0].deletions).toBe(2)
    })

    it('detects binary files', () => {
      const result = parseGitDiff(binaryDiff)
      expect(result.files[0].isBinary).toBe(true)
    })

    it('handles empty diff', () => {
      const result = parseGitDiff('')
      expect(result.totalFiles).toBe(0)
      expect(result.files).toEqual([])
    })

    it('handles multiple files', () => {
      const multi = sampleDiff + '\n' + sampleDiffWithAdd
      const result = parseGitDiff(multi)
      expect(result.totalFiles).toBe(2)
    })

    it('computes totals across files', () => {
      const multi = sampleDiff + '\n' + sampleDiffWithAdd
      const result = parseGitDiff(multi)
      expect(result.totalAdditions).toBe(4 + 3)
      expect(result.totalDeletions).toBe(2)
    })
  })

  describe('formatFileList', () => {
    it('shows file count and stats', () => {
      const diff = parseGitDiff(sampleDiff)
      const out = formatFileList(diff)
      expect(out).toContain('1 file')
      expect(out).toContain('src/foo.ts')
      expect(out).toContain('+4')
      expect(out).toContain('-2')
    })

    it('handles empty diff', () => {
      expect(formatFileList({ files: [], totalAdditions: 0, totalDeletions: 0, totalFiles: 0 }))
        .toContain('No changes')
    })

    it('shows status icon for modified', () => {
      const diff = parseGitDiff(sampleDiff)
      const out = formatFileList(diff)
      expect(out).toContain('✎') // modified icon
    })

    it('shows status icon for added', () => {
      const diff = parseGitDiff(sampleDiffWithAdd)
      const out = formatFileList(diff)
      expect(out).toContain('✚') // added icon
    })

    it('shows status icon for deleted', () => {
      const diff = parseGitDiff(sampleDiffWithDelete)
      const out = formatFileList(diff)
      expect(out).toContain('✖') // deleted icon
    })

    it('marks binary files', () => {
      const diff = parseGitDiff(binaryDiff)
      const out = formatFileList(diff)
      expect(out).toContain('binary')
    })

    it('numbers files', () => {
      const multi = sampleDiff + '\n' + sampleDiffWithAdd
      const diff = parseGitDiff(multi)
      const out = formatFileList(diff)
      expect(out).toContain('1.')
      expect(out).toContain('2.')
    })
  })

  describe('formatFileDetail', () => {
    it('shows file path and stats', () => {
      const diff = parseGitDiff(sampleDiff)
      const out = formatFileDetail(diff, 0)
      expect(out).toContain('src/foo.ts')
      expect(out).toContain('addition')
      expect(out).toContain('deletion')
    })

    it('shows hunk headers', () => {
      const diff = parseGitDiff(sampleDiff)
      const out = formatFileDetail(diff, 0)
      expect(out).toContain('@@')
    })

    it('shows diff lines with + and - markers', () => {
      const diff = parseGitDiff(sampleDiff)
      const out = formatFileDetail(diff, 0)
      // Should contain green + and red - indicators (ANSI codes)
      expect(out).toContain('\x1b[32m')
      expect(out).toContain('\x1b[31m')
    })

    it('handles binary files', () => {
      const diff = parseGitDiff(binaryDiff)
      const out = formatFileDetail(diff, 0)
      expect(out).toContain('Binary')
    })

    it('returns error for invalid index', () => {
      const diff = parseGitDiff(sampleDiff)
      const out = formatFileDetail(diff, 5)
      expect(out).toContain('Invalid')
    })
  })

  describe('formatDiffStat', () => {
    it('shows histogram bars', () => {
      const diff = parseGitDiff(sampleDiff)
      const out = formatDiffStat(diff)
      expect(out).toContain('src/foo.ts')
      expect(out).toContain('|')
    })

    it('shows totals at bottom', () => {
      const diff = parseGitDiff(sampleDiff)
      const out = formatDiffStat(diff)
      expect(out).toContain('file(s) changed')
      expect(out).toContain('insertion')
      expect(out).toContain('deletion')
    })

    it('handles empty diff', () => {
      expect(formatDiffStat({ files: [], totalAdditions: 0, totalDeletions: 0, totalFiles: 0 }))
        .toContain('No changes')
    })

    it('shows +/- in bar', () => {
      const diff = parseGitDiff(sampleDiff)
      const out = formatDiffStat(diff)
      expect(out).toContain('+')
      expect(out).toContain('-')
    })
  })

  describe('formatBriefSummary', () => {
    it('returns clean for no changes', () => {
      expect(formatBriefSummary({ files: [], totalAdditions: 0, totalDeletions: 0, totalFiles: 0 }))
        .toBe('clean')
    })

    it('shows counts for changes', () => {
      const diff = parseGitDiff(sampleDiff)
      const out = formatBriefSummary(diff)
      expect(out).toContain('file')
      expect(out).toContain('+4')
      expect(out).toContain('-2')
    })
  })

  describe('git integration', () => {
    it('getGitDiff returns string', () => {
      const result = getGitDiff(process.cwd())
      expect(typeof result).toBe('string')
    })

    it('getFullDiff returns string', () => {
      const result = getFullDiff(process.cwd())
      expect(typeof result).toBe('string')
    })

    it('getFileDiff returns string for a file', () => {
      const result = getFileDiff(process.cwd(), 'src/core/engine.ts')
      expect(typeof result).toBe('string')
    })

    it('handles non-git directory gracefully', () => {
      expect(() => getGitDiff('/tmp')).not.toThrow()
    })
  })
})
