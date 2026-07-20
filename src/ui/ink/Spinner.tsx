/**
 * Spinner — animated loading indicator with rotating verb + elapsed timer.
 * Uses Ink's useInterval pattern (state + useEffect timer).
 */

import { Text, Box } from 'ink'
import { useState, useEffect, useRef } from 'react'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function formatElapsed(ms: number): string {
  if (ms < 1000) return ''
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rs = Math.round(s % 60)
  return `${m}m${rs}s`
}

export function Spinner({
  active,
  verb,
}: {
  active: boolean
  verb: string
}): React.ReactElement | null {
  const [frame, setFrame] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef<number>(0)

  useEffect(() => {
    if (!active) {
      setElapsed(0)
      return
    }
    startRef.current = Date.now()
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length)
      setElapsed(Date.now() - startRef.current)
    }, 60)
    return () => clearInterval(timer)
  }, [active])

  if (!active) return null

  const elapsedStr = formatElapsed(elapsed)

  return (
    <Box>
      <Text color="magenta">{FRAMES[frame]}</Text>
      <Text dimColor> {verb}{elapsedStr ? ` · ${elapsedStr}` : ''}...</Text>
    </Box>
  )
}
