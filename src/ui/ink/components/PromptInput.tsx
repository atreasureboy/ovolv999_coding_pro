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
import { t } from '../../theme.js'
import { useState, useCallback, useEffect, useMemo } from 'react'
import { SlashMenu, type SlashEntry } from './SlashMenu.js'
import { FileSuggestMenu } from './FileSuggestMenu.js'
import { HistorySearchOverlay } from './HistorySearchOverlay.js'
import { suggestFiles } from '../fileSuggest.js'
import { pasteStore } from '../pasteStore.js'
import { openInEditor } from '../../../utils/editor.js'
import { listCommands } from '../../../commands/index.js'
import { normalizeSlashCommandInput } from '../../../commands/index.js'

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
  /**
   * Round 47: reports whether the composer holds no text and no
   * overlay/search is active. PRINTABLE-char global bindings (like `?`
   * for help) MUST gate on this — useInput is broadcast, so the App
   * handler sees every typed character and `what?` would otherwise pop
   * the help overlay mid-sentence.
   */
  onComposerEmptyChange?: (empty: boolean) => void
  /**
   * Round 46 (codex queue): while a turn runs the input stays usable and
   * Enter QUEUES the message. When set, shows the queue depth hint.
   */
  queueHint?: number
  terminalWidth?: number
}

export function PromptInput({
  onSubmit,
  disabled,
  queueHint,
  onInterrupt,
  skills,
  history,
  cwd,
  onCopy,
  onComposerEmptyChange,
  terminalWidth = 80,
}: PromptInputProps): React.ReactElement {
  const { setRawMode } = useStdin()
  const [text, setText] = useState('')
  const [cursor, setCursor] = useState(0)
  const [histIdx, setHistIdx] = useState(-1)
  const [menuSelected, setMenuSelected] = useState(0)
  const [fileSelected, setFileSelected] = useState(0)
  const [searchMode, setSearchMode] = useState(false)
  useEffect(() => {
    onComposerEmptyChange?.(text.trim().length === 0 && !searchMode)
  }, [text, searchMode, onComposerEmptyChange])

  // ── Compute slash menu entries ────────────────────────────────────────────

  const normalizedCommandText = normalizeSlashCommandInput(text)
  const queueHintActive = disabled && queueHint !== undefined
  const showMenu = normalizedCommandText.startsWith('/') && !normalizedCommandText.includes(' ') && !disabled

  const menuEntries: SlashEntry[] = (() => {
    if (!showMenu) return []
    const partial = normalizedCommandText.slice(1).toLowerCase()
    const cmds = listCommands()
    const coreSet = new Set(['plan', 'gear', 'model', 'resume', 'status', 'clear', 'exit', 'diff', 'undo', 'history'])

    const getCat = (name: string): string => {
      if (coreSet.has(name)) return 'Core'
      if (['sessions', 'export', 'compact'].includes(name)) return 'Session'
      if (['route', 'why', 'workers', 'doctor', 'health', 'audit', 'stats'].includes(name)) return 'Diagnostics'
      return 'Tools'
    }

    if (!partial) {
      const featuredNames = ['plan', 'gear', 'model', 'resume', 'status', 'diff', 'undo', 'history', 'clear', 'exit']
      return featuredNames
        .map(name => cmds.find(command => command.name === name))
        .filter((command): command is NonNullable<typeof command> => Boolean(command))
        .map(command => ({
          name: command.name,
          description: command.description,
          kind: 'cmd',
          category: getCat(command.name),
        }))
    }

    const isFuzzyMatch = (pat: string, str: string): boolean => {
      let p = 0
      for (let i = 0; i < str.length && p < pat.length; i++) {
        if (str[i] === pat[p]) p++
      }
      return p === pat.length
    }

    const out: SlashEntry[] = []
    for (const c of cmds) {
      const cName = c.name.toLowerCase()
      if (cName.startsWith(partial) || isFuzzyMatch(partial, cName)) {
        out.push({
          name: c.name,
          description: c.description,
          kind: 'cmd',
          category: getCat(c.name),
        })
      }
    }
    for (const s of skills) {
      const sName = s.name.toLowerCase()
      if (sName.startsWith(partial) || isFuzzyMatch(partial, sName)) {
        out.push({
          name: s.name,
          description: s.description,
          kind: 'skill',
          category: 'Skills',
        })
      }
    }

    // Sort: exact prefix match first, then fuzzy
    return out.sort((a, b) => {
      const aPrefix = a.name.toLowerCase().startsWith(partial) ? 0 : 1
      const bPrefix = b.name.toLowerCase().startsWith(partial) ? 0 : 1
      if (aPrefix !== bPrefix) return aPrefix - bPrefix
      return a.name.localeCompare(b.name)
    })
  })()

  useEffect(() => {
    setMenuSelected(0)
  }, [text])

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
      const selected = menuEntries[Math.min(menuSelected, menuEntries.length - 1)]
      if (normalizedCommandText !== `/${selected.name}`) {
        autocomplete()
        return
      }
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
  }, [text, normalizedCommandText, showMenu, menuEntries, autocomplete, fileContext, fileSuggestions, autocompleteFile, onSubmit])

  useInput((input, key) => {
    // ── ESC: interrupt ───────────────────────────────────────────────────
    if (key.escape) {
      if (disabled) onInterrupt?.()
      return
    }

    // Round 46 (codex queue): while a turn runs, typing still works —
    // Enter submits into the QUEUE (handleSubmit routes it). Everything
    // stays editable; only autocompletes that need engine state are off.
    if (disabled && !queueHintActive) return

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

  // Round 46 (codex layout language): no chrome. A bare `›` prompt on a
  // quiet line — no heading banner, no border box. Codex's whole composer
  // is `› Ask Codex to do anything` and a footer; everything else is
  // noise. Multi-line still needs an explicit hint (Ctrl+J is not
  // discoverable), rendered as a dim trailing note instead of a frame.

  return (
    <Box flexDirection="column">
      {hasNewline ? (
        // Multi-line render: each line, cursor on the active line.
        <Box width={terminalWidth} flexDirection="column">
          <Box>
            <Text color={t.primary}>› </Text>
            <Text>{text.split('\n')[0]}</Text>
          </Box>
          {text.split('\n').slice(1).map((line, i, arr) => {
            const lineStart = text.split('\n').slice(0, i + 1).join('\n').length + 1
            const relCursor = cursor - lineStart
            const isCursorLine = relCursor >= 0 && relCursor <= line.length
            return (
              <Box key={i} paddingLeft={2}>
                {isCursorLine ? (
                  <>
                    <Text>{line.slice(0, Math.max(0, relCursor))}</Text>
                    <Text backgroundColor={t.primary} color="#1a1a1a">
                      {relCursor < line.length ? line[relCursor] : ' '}
                    </Text>
                    {relCursor < line.length ? <Text>{line.slice(relCursor + 1)}</Text> : null}
                  </>
                ) : (
                  <Text>{line || ' '}</Text>
                )}
              </Box>
            )
          })}
          <Text color={t.faint}>  Ctrl+J newline · Enter submit</Text>
        </Box>
      ) : (
        <Box paddingLeft={1}>
          <Text color={t.primary}>› </Text>
          {text.length === 0 && cursor === 0 ? (
            <Text color={t.faint}>
              {queueHint !== undefined
                ? `enter to queue for after this turn${queueHint > 0 ? ` · ${queueHint} queued` : ''}`
                : 'Ask ovolv999 to do anything…'}
            </Text>
          ) : cursor === text.length && text.length > 0 ? (
            <>
              <Text>{text.slice(0, -1)}</Text>
              <Text backgroundColor={t.primary} color="#1a1a1a">{text.at(-1)}</Text>
            </>
          ) : (
            <>
              <Text>{text.slice(0, cursor)}</Text>
              <Text backgroundColor={t.primary} color="#1a1a1a">{cursor < text.length ? text[cursor] : ' '}</Text>
              {cursor < text.length ? <Text>{text.slice(cursor + 1)}</Text> : null}
            </>
          )}
        </Box>
      )}
      {showMenu && menuEntries.length > 0 ? (
        <SlashMenu entries={menuEntries} selected={menuSelected} />
      ) : null}
      {showMenu && menuEntries.length === 0 && text.length > 1 ? (
        <Text dimColor> No matching commands. Type /? to show all commands.</Text>
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
