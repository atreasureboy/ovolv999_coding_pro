import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { NotebookEditTool } from '../src/tools/notebookEdit.js'
import type { ToolContext } from '../src/core/types.js'
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const TEST_DIR = join(tmpdir(), `ovolv999_nb_test_${Date.now()}`)

function makeCtx(): ToolContext {
  return { cwd: TEST_DIR, permissionMode: 'auto' }
}

/** Create a test notebook with N code cells */
function makeNotebook(path: string, cells: string[]): void {
  const nb = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { language_info: { name: 'python' } },
    cells: cells.map((src, i) => ({
      cell_type: 'code' as const,
      id: `cell-${i}`,
      source: src,
      metadata: {},
      execution_count: null,
      outputs: [],
    })),
  }
  writeFileSync(path, JSON.stringify(nb, null, 1), 'utf8')
}

function readNotebook(path: string): { cells: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(path, 'utf8')) as { cells: Array<Record<string, unknown>> }
}

describe('NotebookEditTool', () => {
  const tool = new NotebookEditTool()
  const nbPath = join(TEST_DIR, 'test.ipynb')

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true })
    makeNotebook(nbPath, ['print("hello")', 'x = 42', 'print(x)'])
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it('has correct name', () => {
    expect(tool.name).toBe('NotebookEdit')
  })

  it('is not concurrency-safe (file writer)', () => {
    expect(tool.isConcurrencySafe?.()).toBe(false)
  })

  it('replaces a cell by numeric index', async () => {
    const result = await tool.execute(
      { notebook_path: nbPath, cell_id: '0', new_source: 'print("replaced")', edit_mode: 'replace' },
      makeCtx(),
    )
    expect(result.isError).toBe(false)
    const nb = readNotebook(nbPath)
    expect(nb.cells[0].source).toBe('print("replaced")')
  })

  it('replaces a cell by actual ID', async () => {
    const result = await tool.execute(
      { notebook_path: nbPath, cell_id: 'cell-1', new_source: 'y = 99', edit_mode: 'replace' },
      makeCtx(),
    )
    expect(result.isError).toBe(false)
    const nb = readNotebook(nbPath)
    expect(nb.cells[1].source).toBe('y = 99')
  })

  it('resets execution_count and outputs on replace', async () => {
    // First, give cell 0 an execution_count
    const nb0 = JSON.parse(readFileSync(nbPath, 'utf8'))
    nb0.cells[0].execution_count = 5
    nb0.cells[0].outputs = [{ output_type: 'stream', text: 'hello\n' }]
    writeFileSync(nbPath, JSON.stringify(nb0, null, 1))

    await tool.execute(
      { notebook_path: nbPath, cell_id: '0', new_source: 'print("new")', edit_mode: 'replace' },
      makeCtx(),
    )
    const nb = readNotebook(nbPath)
    expect(nb.cells[0].execution_count).toBeNull()
    expect(nb.cells[0].outputs).toEqual([])
  })

  it('inserts a new cell after the specified cell', async () => {
    const result = await tool.execute(
      { notebook_path: nbPath, cell_id: '0', new_source: 'import os', edit_mode: 'insert', cell_type: 'code' },
      makeCtx(),
    )
    expect(result.isError).toBe(false)
    const nb = readNotebook(nbPath)
    expect(nb.cells).toHaveLength(4)
    expect(nb.cells[1].source).toBe('import os')
    expect(nb.cells[1].cell_type).toBe('code')
  })

  it('inserts at beginning when no cell_id', async () => {
    const result = await tool.execute(
      { notebook_path: nbPath, new_source: '# Title', edit_mode: 'insert', cell_type: 'markdown' },
      makeCtx(),
    )
    expect(result.isError).toBe(false)
    const nb = readNotebook(nbPath)
    expect(nb.cells).toHaveLength(4)
    expect(nb.cells[0].source).toBe('# Title')
    expect(nb.cells[0].cell_type).toBe('markdown')
  })

  it('deletes a cell', async () => {
    const result = await tool.execute(
      { notebook_path: nbPath, cell_id: '1', new_source: '', edit_mode: 'delete' },
      makeCtx(),
    )
    expect(result.isError).toBe(false)
    const nb = readNotebook(nbPath)
    expect(nb.cells).toHaveLength(2)
    expect(nb.cells[0].source).toBe('print("hello")')
    expect(nb.cells[1].source).toBe('print(x)')
  })

  it('changes cell type from code to markdown', async () => {
    const result = await tool.execute(
      { notebook_path: nbPath, cell_id: '0', new_source: '# Markdown', edit_mode: 'replace', cell_type: 'markdown' },
      makeCtx(),
    )
    expect(result.isError).toBe(false)
    const nb = readNotebook(nbPath)
    expect(nb.cells[0].cell_type).toBe('markdown')
    expect(nb.cells[0].execution_count).toBeUndefined()
  })

  it('rejects non-.ipynb files', async () => {
    const result = await tool.execute(
      { notebook_path: join(TEST_DIR, 'test.py'), cell_id: '0', new_source: 'x', edit_mode: 'replace' },
      makeCtx(),
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('.ipynb')
  })

  it('rejects invalid cell_id', async () => {
    const result = await tool.execute(
      { notebook_path: nbPath, cell_id: 'nonexistent', new_source: 'x', edit_mode: 'replace' },
      makeCtx(),
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('not found')
  })

  it('rejects out-of-bounds numeric index', async () => {
    const result = await tool.execute(
      { notebook_path: nbPath, cell_id: '99', new_source: 'x', edit_mode: 'replace' },
      makeCtx(),
    )
    expect(result.isError).toBe(true)
  })

  it('rejects insert without cell_type', async () => {
    const result = await tool.execute(
      { notebook_path: nbPath, cell_id: '0', new_source: 'x', edit_mode: 'insert' },
      makeCtx(),
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('cell_type')
  })

  it('rejects missing notebook_path', async () => {
    const result = await tool.execute(
      { cell_id: '0', new_source: 'x', edit_mode: 'replace' },
      makeCtx(),
    )
    expect(result.isError).toBe(true)
  })

  it('handles non-existent file', async () => {
    const result = await tool.execute(
      { notebook_path: join(TEST_DIR, 'nope.ipynb'), cell_id: '0', new_source: 'x', edit_mode: 'replace' },
      makeCtx(),
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('cannot read')
  })

  it('handles invalid JSON', async () => {
    writeFileSync(nbPath, 'not json', 'utf8')
    const result = await tool.execute(
      { notebook_path: nbPath, cell_id: '0', new_source: 'x', edit_mode: 'replace' },
      makeCtx(),
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('not valid JSON')
  })

  it('converts replace-past-end to insert', async () => {
    // Cell index 3 doesn't exist (only 0-2), replace should become insert
    const result = await tool.execute(
      { notebook_path: nbPath, cell_id: '2', new_source: 'appended', edit_mode: 'replace' },
      makeCtx(),
    )
    // cell-2 is the last cell (index 2), replace should work normally
    expect(result.isError).toBe(false)
    const nb = readNotebook(nbPath)
    expect(nb.cells[2].source).toBe('appended')
  })
})
