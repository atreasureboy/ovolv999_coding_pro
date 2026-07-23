/**
 * NotebookEditTool — edit Jupyter notebook (.ipynb) cells
 *
 * Inspired by Claude Code's NotebookEditTool.
 *
 * Supports three operations:
 *   - replace: overwrite a cell's source code
 *   - insert: add a new cell after the specified cell (or at beginning)
 *   - delete: remove a cell
 *
 * Cell identification: by actual cell ID, or by numeric index ("0", "1", ...).
 * The notebook is read as JSON, modified, and written back.
 */

import { readFileSync } from 'fs'
import { extname, resolve, isAbsolute } from 'path'
import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import type { ResourceClaim } from '../core/executionRun.js'
import { atomicWrite } from '../core/atomicWrite.js'

// ── Types ───────────────────────────────────────────────────────────────────

interface NotebookCell {
  cell_type: 'code' | 'markdown'
  id?: string
  source: string
  metadata: Record<string, unknown>
  execution_count?: number | null
  outputs?: unknown[]
}

interface NotebookContent {
  nbformat: number
  nbformat_minor: number
  metadata?: {
    language_info?: { name?: string }
    [k: string]: unknown
  }
  cells: NotebookCell[]
}

type EditMode = 'replace' | 'insert' | 'delete'

// ── Tool ────────────────────────────────────────────────────────────────────

export class NotebookEditTool implements Tool {
  name = 'NotebookEdit'
  metadata = {
    mutatesState: true,
    concurrencySafe: false,
    claims: (input: Record<string, unknown>): ResourceClaim[] => {
      const p = typeof input.notebook_path === 'string' ? input.notebook_path : ''
      return p ? [{ type: 'file', key: `file:${p}`, access: 'write' as const }] : []
    },
  }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'NotebookEdit',
      description: `Edit a Jupyter notebook (.ipynb) cell — replace, insert, or delete.

## Operations
- **replace** (default): overwrite the source of an existing cell
- **insert**: add a new cell AFTER the specified cell_id (or at the beginning if no cell_id)
- **delete**: remove the specified cell

## Cell Identification
- Use the cell's actual ID (from the notebook JSON), OR
- Use a numeric index as a string: "0", "1", "2", etc.

## Requirements
- File must be a .ipynb file
- Read the notebook first before editing
- For insert, cell_type is required (code or markdown)

## Example
NotebookEdit({
  notebook_path: "/path/to/notebook.ipynb",
  cell_id: "0",
  new_source: "import pandas as pd",
  edit_mode: "replace"
})`,
      parameters: {
        type: 'object',
        properties: {
          notebook_path: {
            type: 'string',
            description: 'Absolute path to the .ipynb file',
          },
          cell_id: {
            type: 'string',
            description: 'Cell ID or numeric index. Required for replace/delete. For insert, the new cell goes AFTER this cell.',
          },
          new_source: {
            type: 'string',
            description: 'The new source code for the cell',
          },
          cell_type: {
            type: 'string',
            enum: ['code', 'markdown'],
            description: 'Cell type (required for insert, defaults to current type for replace)',
          },
          edit_mode: {
            type: 'string',
            enum: ['replace', 'insert', 'delete'],
            description: 'Edit mode (default: replace)',
          },
        },
        required: ['notebook_path'],
      },
    },
  }

  isConcurrencySafe(): boolean {
    return false // File-writing tool — serial execution
  }

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    return this.doEdit(input, ctx)
  }

  private async doEdit(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const notebookPath = input.notebook_path as string
    const cellId = input.cell_id as string | undefined
    const newSource = input.new_source as string
    const cellType = input.cell_type as 'code' | 'markdown' | undefined
    const editMode = (input.edit_mode ?? 'replace') as EditMode

    // Validate path
    if (!notebookPath) {
      return { content: 'Error: notebook_path is required', isError: true }
    }
    const fullPath = isAbsolute(notebookPath) ? notebookPath : resolve(ctx.cwd, notebookPath)
    if (extname(fullPath) !== '.ipynb') {
      return { content: 'Error: file must be a Jupyter notebook (.ipynb)', isError: true }
    }

    // Validate edit_mode
    if (!['replace', 'insert', 'delete'].includes(editMode)) {
      return { content: 'Error: edit_mode must be replace, insert, or delete', isError: true }
    }

    // Validate cell_type for insert
    if (editMode === 'insert' && !cellType) {
      return { content: 'Error: cell_type is required when edit_mode=insert', isError: true }
    }

    // For delete, new_source is not needed but the schema requires it — relax
    if (editMode !== 'delete' && !newSource) {
      return { content: 'Error: new_source is required for replace/insert', isError: true }
    }

    // Read the notebook
    let content: string
    try {
      content = readFileSync(fullPath, 'utf8')
    } catch {
      return { content: `Error: cannot read file: ${fullPath}`, isError: true }
    }

    let notebook: NotebookContent
    try {
      notebook = JSON.parse(content) as NotebookContent
    } catch {
      return { content: 'Error: notebook is not valid JSON', isError: true }
    }

    if (!notebook.cells || !Array.isArray(notebook.cells)) {
      return { content: 'Error: notebook has no cells array', isError: true }
    }

    // Find cell index
    let cellIndex: number
    if (editMode === 'insert' && !cellId) {
      cellIndex = 0 // insert at beginning
    } else if (!cellId) {
      return { content: 'Error: cell_id is required for replace/delete', isError: true }
    } else {
      // Try to find by actual ID first
      cellIndex = notebook.cells.findIndex((c) => c.id === cellId)
      if (cellIndex === -1) {
        // Try numeric index
        const parsed = parseInt(cellId, 10)
        if (!isNaN(parsed) && parsed >= 0 && parsed < notebook.cells.length) {
          cellIndex = parsed
        } else {
          return { content: `Error: cell "${cellId}" not found in notebook`, isError: true }
        }
      }
      if (editMode === 'insert') cellIndex += 1 // insert AFTER the specified cell
    }

    // Handle replace-past-end → convert to insert
    let actualEditMode = editMode
    if (editMode === 'replace' && cellIndex >= notebook.cells.length) {
      actualEditMode = 'insert'
    }

    const language = notebook.metadata?.language_info?.name ?? 'python'

    // Perform the operation
    if (actualEditMode === 'delete') {
      notebook.cells.splice(cellIndex, 1)
    } else if (actualEditMode === 'insert') {
      const newCell: NotebookCell =
        cellType === 'markdown'
          ? { cell_type: 'markdown', source: newSource, metadata: {} }
          : { cell_type: 'code', source: newSource, metadata: {}, execution_count: null, outputs: [] }
      notebook.cells.splice(cellIndex, 0, newCell)
    } else {
      // replace
      const target = notebook.cells[cellIndex]
      if (!target) {
        return { content: `Error: cell index ${cellIndex} out of bounds`, isError: true }
      }
      target.source = newSource
      if (target.cell_type === 'code') {
        target.execution_count = null
        target.outputs = []
      }
      if (cellType && cellType !== target.cell_type) {
        target.cell_type = cellType
        if (cellType === 'markdown') {
          delete target.execution_count
          delete target.outputs
        } else {
          target.execution_count = null
          target.outputs = []
        }
      }
    }

    // Back up before modifying (undo/checkpoint support)
    ctx.fileHistory?.trackEdit(fullPath)

    // Write back — atomic so a crash mid-write cannot leave a half-
    // written notebook on disk (which Jupyter would refuse to open).
    try {
      await atomicWrite(fullPath, JSON.stringify(notebook, null, 1), { encoding: 'utf8' })
    } catch (err) {
      return { content: `Error writing notebook: ${(err as Error).message}`, isError: true }
    }

    const action =
      actualEditMode === 'delete' ? 'Deleted' :
      actualEditMode === 'insert' ? 'Inserted' : 'Updated'
    return {
      content: `${action} cell ${cellId ?? '0'} in ${fullPath} (${language})`,
      isError: false,
    }
  }
}
