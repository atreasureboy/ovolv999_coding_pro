/**
 * PromptInput — the main interactive input component.
 *
 * Handles:
 * - Text editing (type, backspace, arrows, Home/End, Ctrl+U clear)
 * - Live slash command suggestions (SlashMenu) when input starts with `/`
 * - Arrow-key navigation of the slash menu
 * - Tab to autocomplete selected command
 * - Enter to submit
 * - Up/Down history navigation (when not in slash menu mode)
 * - ESC to interrupt (when running)
 *
 * Uses Ink's useInput for raw keyboard access. This component owns ALL keyboard
 * input — no other component should call useInput while the REPL is active.
 */

import { Text, Box, useInput, useStdin } from 'ink'
import { useState, useCallback, useEffect, useMemo } from 'react'
import { SlashMenu, type SlashEntry } from './SlashMenu.js'
import { FileSuggestMenu } from './FileSuggestMenu.js'
import { HistorySearchOverlay } from './HistorySearchOverlay.js'
import { suggestFiles } from '../fileSuggest.js'
import { pasteStore } from '../pasteStore.js'
import { openInEditor } from '../../../utils/editor.js'
import { listCommands } from '../../../commands/index.js'

export interface PromptInputProps {
  /** Called when the user presses Enter with non-empty text. */
  onSubmit: (text: string) => void
  /** Whether a turn is running (disables input, shows spinner instead). */
  disabled: boolean
  /** Called when ESC is pressed during a running turn. */
  onInterrupt?: () => void
  /** Skills for slash menu (name + description pairs). */
  skills: Array<{ name: string; description: string }>
  /** History for Up/Down navigation. */
  history: string[]
  /** Working directory for @-mention file autocomplete. */
  cwd: string
  /** Called when user presses Ctrl+Y (copy last reply). */
  onCopy?: () => void
}

export function PromptInput({
  onSubmit,
  disabled,
  onInterrupt,
  skills,
  history,
  cwd,
  onCopy,
}: PromptInputProps): React.ReactElement {
  const { setRawMode } = useStdin()
  const [text, setText] = useState('')
  const [cursor, setCursor] = useState(0)
  const [histIdx, setHistIdx] = useState(-1)
  const [menuSelected, setMenuSelected] = useState(0)
  const [fileSelected, setFileSelected] = useState(0)
  const [searchMode, setSearchMode] = useState(false)

  // ── Compute slash menu entries ────────────────────────────────────────────

  const showMenu = text.startsWith('/') && !text.includes(' ') && !disabled

  const menuEntries: SlashEntry[] = (() => {
    if (!showMenu) return []
    const partial = text.slice(1).toLowerCase()
    const cmds = listCommands()
    const out: SlashEntry[] = []
    for (const c of cmds) {
      if (!partial || c.name.toLowerCase().startsWith(partial)) {
        out.push({ name: c.name, description: c.description, kind: 'cmd' })
      }
    }
    if (partial) {
      for (const s of skills) {
        if (s.name.toLowerCase().startsWith(partial)) {
          out.push({ name: s.name, description: s.description, kind: 'skill' })
        }
    }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  })()

  // Clamp selection when entries change
  useEffect(() => {
    if (menuSelected >= menuEntries.length) setMenuSelected(0)
  }, [menuEntries.length, menuSelected])

  // ── @-mention file suggestions ───────────────────────────────────────────

  const fileContext = useMemo((): { active: boolean; query: string; atIdx: number } => {
    if (disabled || showMenu) return { active: false, query: '', atIdx: -1 }
    const beforeCursor = text.slice(0, cursor)
    // Find the last @ that is preceded by start-of-string or whitespace
    const atMatch = beforeCursor.match(/(?:^|\s)@([^\s]*)$/)
    if (!atMatch) return { active: false, query: '', atIdx: -1 }
    const atIdx = beforeCursor.lastIndexOf('@')
    return { active: true, query: atMatch[1], atIdx }
  }, [text, cursor, disabled, showMenu])

  const fileSuggestions = useMemo(() => {
    if (!fileContext.active) return []
    return suggestFiles(cwd, fileContext.query)
  }, [fileContext.active, fileContext.query, cwd])

  useEffect(() => {
    if (fileSelected >= fileSuggestions.length) setFileSelected(0)
  }, [fileSuggestions.length, fileSelected])

  const autocompleteFile = useCallback(() => {
    if (fileSuggestions.length === 0) return
    const sel = fileSuggestions[Math.min(fileSelected, fileSuggestions.length - 1)]
    const before = text.slice(0, fileContext.atIdx)
    const after = text.slice(cursor)
    const insertion = '@' + sel.path + (sel.isDir ? '/' : ' ')
    const newText = before + insertion + after
    setText(newText)
    setCursor(before.length + insertion.length)
  }, [fileSuggestions, fileSelected, fileContext.atIdx, text, cursor])

  // ── Input handling ────────────────────────────────────────────────────────

  const autocomplete = useCallback(() => {
    if (menuEntries.length === 0) return
    const entry = menuEntries[Math.min(menuSelected, menuEntries.length - 1)]
    const newText = '/' + entry.name + ' '
    setText(newText)
    setCursor(newText.length)
  }, [menuEntries, menuSelected])

  const handleSubmit = useCallback(() => {
    if (showMenu && menuEntries.length > 0) {
      autocomplete()
      return
    }
    if (fileContext.active && fileSuggestions.length > 0) {
      autocompleteFile()
      return
    }
    const trimmed = text.trim()
    if (trimmed) {
      onSubmit(pasteStore.expand(trimmed))
      setText('')
      setCursor(0)
      setHistIdx(-1)
    }
  }, [text, showMenu, menuEntries, autocomplete, fileContext, fileSuggestions, autocompleteFile, onSubmit])

  useInput((input, key) => {
    // ── ESC: interrupt ───────────────────────────────────────────────────
    if (key.escape) {
      if (disabled) onInterrupt?.()
      return
    }

    if (disabled) return

    // ── Enter: submit or autocomplete ────────────────────────────────────
    if (key.return) {
      handleSubmit()
      return
    }

    // ── Tab: autocomplete ────────────────────────────────────────────────
    if (key.tab) {
      if (showMenu) { autocomplete(); return }
      if (fileContext.active && fileSuggestions.length > 0) { autocompleteFile(); return }
      return
    }

    // ── Ctrl+R: reverse history search ───────────────────────────────────
    if (input === '\x12') {
      if (history.length > 0) setSearchMode(true)
      return
    }

    // ── Ctrl+Y: copy last assistant reply ────────────────────────────────
    if (input === '\x19') {
      onCopy?.()
      return
    }

    // ── Ctrl+G: open external editor ─────────────────────────────────────
    if (input === '\x07') {
      // Suspend raw mode so the editor can take over the terminal
      if (setRawMode) setRawMode(false)
      const edited = openInEditor(text)
      if (setRawMode) setRawMode(true)
      if (edited !== null) {
        setText(edited)
        setCursor(edited.length)
      }
      return
    }

    // ── Slash menu navigation (arrows) ───────────────────────────────────
    if (showMenu && menuEntries.length > 0) {
      if (key.upArrow) {
        setMenuSelected((s) => (s - 1 + menuEntries.length) % menuEntries.length)
        return
      }
      if (key.downArrow) {
        setMenuSelected((s) => (s + 1) % menuEntries.length)
        return
      }
    }

    // ── File menu navigation (arrows) ────────────────────────────────────
    if (fileContext.active && fileSuggestions.length > 0) {
      if (key.upArrow) {
        setFileSelected((s) => (s - 1 + fileSuggestions.length) % fileSuggestions.length)
        return
      }
      if (key.downArrow) {
        setFileSelected((s) => (s + 1) % fileSuggestions.length)
        return
      }
    }

    // ── History navigation (when not in slash menu) ──────────────────────
    if (!showMenu && history.length > 0) {
      if (key.upArrow) {
        const newIdx = histIdx === -1 ? history.length - 1 : Math.max(0, histIdx - 1)
        setHistIdx(newIdx)
        setText(history[newIdx])
        setCursor(history[newIdx].length)
        return
      }
      if (key.downArrow) {
        if (histIdx === -1) return
        const newIdx = histIdx + 1
        if (newIdx >= history.length) {
          setHistIdx(-1)
          setText('')
          setCursor(0)
        } else {
          setHistIdx(newIdx)
          setText(history[newIdx])
          setCursor(history[newIdx].length)
        }
        return
      }
    }

    // ── Text editing ─────────────────────────────────────────────────────
    if (key.backspace || key.delete) {
      if (cursor > 0) {
        setText(text.slice(0, cursor - 1) + text.slice(cursor))
        setCursor(cursor - 1)
      }
      return
    }

    if (key.leftArrow) {
      setCursor(Math.max(0, cursor - 1))
      return
    }

    if (key.rightArrow) {
      setCursor(Math.min(text.length, cursor + 1))
      return
    }

    // Ctrl+A = Home, Ctrl+E = End, Ctrl+U = clear line
    if (input === '\x01') { setCursor(0); return }
    if (input === '\x05') { setCursor(text.length); return }
    if (input === '\x15') { setText(''); setCursor(0); return }

    // Ctrl+J = newline (multi-line input)
    if (input === '\x0a') {
      const newText = text.slice(0, cursor) + '\n' + text.slice(cursor)
      setText(newText)
      setCursor(cursor + 1)
      return
    }

    // ── Printable characters (including multi-line paste) ───────────────
    if (input && !key.ctrl && !key.meta && input !== '\r' && input !== '\n') {
      // Handle paste (multi-char input possibly containing newlines)
      const insertText = pasteStore.isLargePaste(input)
        ? pasteStore.store(input)
        : input
      const newText = text.slice(0, cursor) + insertText + text.slice(cursor)
      setText(newText)
      setCursor(cursor + insertText.length)
    }
  })

  // ── Render ────────────────────────────────────────────────────────────────

  const hasNewline = text.includes('\n')

  return (
    <Box flexDirection="column">
      {hasNewline ? (
        // Multi-line render: show each line, cursor on the active line
        <Box flexDirection="column">
          <Box>
            <Text bold color="blueBright">❯ </Text>
            <Text dimColor>(multi-line · Ctrl+J=newline · Enter=submit)</Text>
          </Box>
          {text.split('\n').map((line, i, arr) => {
            // Calculate absolute position of this line's start
            const lineStart = i === 0 ? 0 : arr.slice(0, i).join('\n').length + 1
            const relCursor = cursor - lineStart
            const isCursorLine = relCursor >= 0 && relCursor <= line.length
            if (isCursorLine && i === arr.length - 1 || (isCursorLine && relCursor <= line.length)) {
              return (
                <Box key={i} marginLeft={2}>
                  <Text>
                    {line.slice(0, Math.max(0, relCursor))}
                  </Text>
                  <Text color="blueBright">
                    {relCursor < line.length ? line[relCursor] : ' '}
                  </Text>
                  {relCursor < line.length ? <Text>{line.slice(relCursor + 1)}</Text> : null}
                </Box>
              )
            }
            return (
              <Box key={i} marginLeft={2}>
                <Text>{line || ' '}</Text>
              </Box>
            )
          })}
        </Box>
      ) : (
        <Box>
          <Text bold color="blueBright">❯ </Text>
          <Text>
            {text.slice(0, cursor)}
          </Text>
          <Text color="blueBright">{cursor < text.length ? text[cursor] : ' '}</Text>
          {cursor < text.length ? <Text>{text.slice(cursor + 1)}</Text> : null}
        </Box>
      )}
      {showMenu && menuEntries.length > 0 ? (
        <SlashMenu entries={menuEntries} selected={menuSelected} />
      ) : null}
      {showMenu && menuEntries.length === 0 && text.length > 1 ? (
        <Text dimColor> No matching commands. Type / for all commands.</Text>
      ) : null}
      {fileContext.active && fileSuggestions.length > 0 ? (
        <FileSuggestMenu suggestions={fileSuggestions} selected={fileSelected} query={fileContext.query} />
      ) : null}
      {searchMode ? (
        <HistorySearchOverlay
          history={history}
          onSelect={(selected) => {
            setText(selected)
            setCursor(selected.length)
            setSearchMode(false)
          }}
          onCancel={() => setSearchMode(false)}
        />
      ) : null}
      {/* Token estimate for non-trivial inputs */}
      {text.trim().length > 50 && !showMenu && !searchMode && !fileContext.active ? (
        <Box>
          <Text dimColor>  ~{Math.ceil(text.length / 4)} tokens · {text.length} chars</Text>
        </Box>
      ) : null}
    </Box>
  )
}
