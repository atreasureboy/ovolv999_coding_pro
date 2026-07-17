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

import { Text, Box, useInput } from 'ink'
import { useState, useCallback, useEffect } from 'react'
import { SlashMenu, type SlashEntry } from './SlashMenu.js'
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
}

export function PromptInput({
  onSubmit,
  disabled,
  onInterrupt,
  skills,
  history,
}: PromptInputProps): React.ReactElement {
  const [text, setText] = useState('')
  const [cursor, setCursor] = useState(0)
  const [histIdx, setHistIdx] = useState(-1)
  const [menuSelected, setMenuSelected] = useState(0)

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
      // Enter in slash menu = autocomplete (same as Tab)
      autocomplete()
      return
    }
    const trimmed = text.trim()
    if (trimmed) {
      onSubmit(trimmed)
      setText('')
      setCursor(0)
      setHistIdx(-1)
    }
  }, [text, showMenu, menuEntries, autocomplete, onSubmit])

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
      if (showMenu) autocomplete()
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
      const newText = text.slice(0, cursor) + input + text.slice(cursor)
      setText(newText)
      setCursor(cursor + input.length)
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
    </Box>
  )
}
