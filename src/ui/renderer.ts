/**
 * Terminal UI Renderer — structured, readable, professional
 *
 * Design:
 * - Compact branded header (not giant ASCII, not bare text)
 * - Each section has a clear visual pattern:
 *     User → colored ❯ with top border
 *     LLM  → clean streaming with subtle left accent
 *     Tool → icon + colored name + preview, results indented
 *     Status → icon + message on dedicated line
 * - Whitespace separates logical sections
 * - Color = hierarchy (not decoration)
 */

import { createWriteStream } from 'fs'
import { str } from '../core/strings.js'

// ── ANSI ────────────────────────────────────────────────────

const R = '\x1b[0m'
const B = '\x1b[1m'
const D = '\x1b[2m'

const C = {
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  purple:  '\x1b[35m',
  cyan:    '\x1b[36m',
  gray:    '\x1b[90m',
  bred:    '\x1b[91m',
  bgreen:  '\x1b[92m',
  byellow: '\x1b[93m',
  bblue:   '\x1b[94m',
  bpurple: '\x1b[95m',
  bcyan:   '\x1b[96m',
  bgray:   '\x1b[37m',
  white:   '\x1b[97m',
}

// ── Spinner ─────────────────────────────────────────────────

const FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏']
const VERBS = [
  'Thinking', 'Analyzing', 'Processing', 'Computing',
  'Reasoning', 'Working', 'Exploring', 'Building',
  'Searching', 'Drafting',
]

// ── Tool visual identity ────────────────────────────────────

interface ToolVisual { icon: string; color: string }

const TOOL_VIZ: Record<string, ToolVisual> = {
  Bash:          { icon: '$',  color: C.byellow },
  Read:          { icon: '📖', color: C.bcyan },
  Write:         { icon: '✎',  color: C.bgreen },
  Edit:          { icon: '✎',  color: C.bblue },
  Glob:          { icon: '◆',  color: C.bpurple },
  Grep:          { icon: '⌕',  color: C.bpurple },
  WebFetch:      { icon: '🌐', color: C.cyan },
  WebSearch:     { icon: '🔍', color: C.cyan },
  TodoWrite:     { icon: '☑',  color: C.bgreen },
  Agent:         { icon: '⊕',  color: C.bpurple },
  ShellSession:  { icon: '⌁',  color: C.bred },
  TmuxSession:   { icon: '⌁',  color: C.bred },
  load_skill:    { icon: '◆',  color: C.bblue },
  memory_write:  { icon: '✦',  color: C.bgreen },
  memory_search: { icon: '✦',  color: C.bcyan },
  memory_recall: { icon: '✦',  color: C.byellow },
  TaskCreate:    { icon: '▶',  color: C.bgreen },
  TaskGet:       { icon: '◉',  color: C.bcyan },
  TaskList:      { icon: '☰',  color: C.bblue },
  TaskUpdate:    { icon: '✎',  color: C.byellow },
  TaskStop:      { icon: '■',  color: C.bred },
  AskUserQuestion: { icon: '?', color: C.byellow },
  ExitPlanMode:   { icon: '⚡', color: C.bgreen },
  Sleep:          { icon: '⏸', color: C.gray },
  NotebookEdit:   { icon: '📓', color: C.bpurple },
}

function viz(name: string): ToolVisual {
  return TOOL_VIZ[name] ?? { icon: '·', color: C.white }
}

// ── Renderer ────────────────────────────────────────────────

export class Renderer {
  private spinTimer: ReturnType<typeof setInterval> | null = null
  private spinFrame = 0
  private spinVerb = 0
  private width: number
  private tty: boolean
  private out: (s: string) => void
  private streaming = false

  private stream: NodeJS.WritableStream | null = null

  constructor(opts?: { stream?: NodeJS.WritableStream }) {
    const s = opts?.stream ?? process.stdout
    this.stream = s
    this.out = (str: string) => { s.write(str) }
    this.tty = (s as NodeJS.WriteStream).isTTY === true
    this.width = this.tty ? ((s as NodeJS.WriteStream).columns ?? 100) : 100
    if (this.tty) {
      (s as NodeJS.WriteStream).on?.('resize', () => {
        this.width = (s as NodeJS.WriteStream).columns ?? 100
      })
    }
  }

  static forFile(path: string): Renderer {
    const fs = createWriteStream(path, { flags: 'a' })
    fs.on('error', () => {})
    return new Renderer({ stream: fs as unknown as NodeJS.WritableStream })
  }

  /** Close the underlying stream if it's a file stream (prevents fd leak) */
  destroy(): void {
    if (this.stream && typeof (this.stream as { end?: () => void }).end === 'function') {
      (this.stream as { end: () => void }).end()
    }
    this.stream = null
  }

  private w(s: string): void { this.out(s) }

  // Helper: dim horizontal rule
  private hr(): string {
    const len = Math.min(this.width - 2, 80)
    return `${D}${C.gray}${'·'.repeat(len)}${R}`
  }

  // ── Banner ────────────────────────────────────────────────

  banner(version: string, model: string): void {
    this.w('\n')
    this.w(`  ${B}${C.bpurple}● ovolv999${R} ${D}${C.gray}v${version}${R}\n`)
    this.w(`  ${D}${C.gray}┤ ${R}${C.bcyan}${model}${R} ${D}${C.gray}├ Think-Act-Observe${R}\n`)
    this.w('\n')
  }

  // ── User message ──────────────────────────────────────────

  humanPrompt(text: string): void {
    this.w(`\n  ${C.bblue}${B}❯${R} ${B}${C.white}${text}${R}\n`)
  }

  // ── LLM streaming ─────────────────────────────────────────

  beginAssistantText(): void {
    this.streaming = true
  }

  streamToken(token: string): void {
    if (!this.streaming) {
      // Ensure spinner is stopped before first token
      this.stopSpinner()
      this.beginAssistantText()
    }
    this.w(token)
  }

  endAssistantText(): void {
    if (this.streaming) {
      this.w('\n')
      this.streaming = false
    }
  }

  // ── Tool calls ────────────────────────────────────────────

  toolStart(name: string, input: Record<string, unknown>): void {
    const v = viz(name)
    const preview = this.preview(name, input)
    this.w(`\n  ${v.color}${v.icon}${R} ${B}${v.color}${name}${R}`)
    if (preview) {
      this.w(` ${D}${C.gray}${preview}${R}`)
    }
    this.w('\n')
  }

  toolResult(name: string, result: string, isError: boolean): void {
    const lines = result.split('\n').filter(l => l.trim())

    if (isError) {
      for (const line of lines.slice(0, 6)) {
        this.w(`    ${C.red}${line.length > 120 ? line.slice(0, 117) + '...' : line}${R}\n`)
      }
      return
    }

    // Show result lines indented and dimmed
    const shown = lines.slice(0, 6)
    const hidden = lines.length - shown.length
    for (const line of shown) {
      const trimmed = line.length > 120 ? line.slice(0, 117) + '...' : line
      this.w(`    ${D}${trimmed}${R}\n`)
    }
    if (hidden > 0) {
      this.w(`    ${D}${C.gray}+${hidden} more${R}\n`)
    }
  }

  private preview(name: string, input: Record<string, unknown>): string {
    switch (name) {
      case 'Bash': {
        const c = str(input.command).trim()
        return c.length > 80 ? c.slice(0, 77) + '...' : c
      }
      case 'Read': {
        const off = input.offset ? ` from line ${str(input.offset)}` : ''
        return str(input.file_path) + off
      }
      case 'Write': {
        return `${str(input.file_path)} (${str(input.content).split('\n').length}L)`
      }
      case 'Edit': {
        return str(input.file_path)
      }
      case 'NotebookEdit': {
        const cell = input.cell_id ? ` cell ${str(input.cell_id)}` : ''
        return `${str(input.notebook_path)}${cell} (${str(input.edit_mode ?? 'replace')})`
      }
      case 'Glob': {
        return str(input.pattern)
      }
      case 'Grep': {
        const g = input.include ? ` [${str(input.include)}]` : ''
        return `/${str(input.pattern)}/${g}`
      }
      case 'WebFetch': {
        return str(input.url)
      }
      case 'WebSearch': {
        return `"${str(input.query)}"`
      }
      case 'Agent': {
        const t = input.subagent_type ? `[${str(input.subagent_type)}] ` : ''
        return `${t}${input.description ? str(input.description) : ''}`
      }
      case 'TodoWrite': {
        const todos = input.todos
        const count = Array.isArray(todos) ? todos.length : 0
        return `${count} item${count === 1 ? '' : 's'}`
      }
      case 'TaskCreate': {
        const cmd = str(input.command).trim()
        return cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd
      }
      case 'TaskGet': {
        const block = input.block ? ' (blocking)' : ''
        return `${str(input.task_id)}${block}`
      }
      case 'TaskList': {
        return ''
      }
      case 'TaskUpdate': {
        return str(input.task_id)
      }
      case 'TaskStop': {
        return str(input.task_id)
      }
      case 'AskUserQuestion': {
        const qs = input.questions
        const count = Array.isArray(qs) ? qs.length : 0
        return `${count} question${count === 1 ? '' : 's'}`
      }
      case 'ExitPlanMode': {
        return 'presenting plan...'
      }
      case 'Sleep': {
        return `${str(input.duration_ms)}ms`
      }
      case 'TmuxSession': {
        return `${str(input.action)} ${str(input.session ?? '')}`.trim()
      }
      case 'ShellSession': {
        return `${str(input.action)} ${str(input.session_id ?? input.port ?? '')}`.trim()
      }
      case 'load_skill': {
        return str(input.skill_name)
      }
      case 'memory_write': {
        return str(input.key)
      }
      case 'memory_search': {
        return `"${str(input.query)}"`
      }
      case 'memory_recall': {
        return str(input.key ?? 'recall')
      }
      default:
        return ''
    }
  }

  // ── Spinner ───────────────────────────────────────────────

  startSpinner(_verb?: string): void {
    if (!this.tty) return
    if (this.spinTimer) this.stopSpinner()
    // Don't start spinner if we're streaming text — would corrupt output
    if (this.streaming) return
    this.spinVerb = Math.floor(Math.random() * VERBS.length)
    this.renderSpin()
    this.spinTimer = setInterval(() => {
      // Guard: stop immediately if streaming started since last tick
      if (this.streaming) {
        this.stopSpinner()
        return
      }
      this.spinFrame = (this.spinFrame + 1) % FRAMES.length
      if (this.spinFrame % 15 === 0) {
        this.spinVerb = (this.spinVerb + 1) % VERBS.length
      }
      this.renderSpin()
    }, 60)
  }

  private renderSpin(): void {
    // Never render spinner while streaming — prevents output corruption
    if (this.streaming) return
    const f = FRAMES[this.spinFrame]
    const v = VERBS[this.spinVerb]
    this.w(`\r  ${C.bpurple}${f}${R} ${D}${v}...${R}  `)
  }

  stopSpinner(): void {
    if (this.spinTimer) {
      clearInterval(this.spinTimer)
      this.spinTimer = null
    }
    if (this.tty && !this.streaming) {
      this.w('\r\x1b[K')
    }
  }

  // ── Status ────────────────────────────────────────────────

  info(msg: string): void {
    this.w(`  ${D}${C.gray}${msg}${R}\n`)
  }

  success(msg: string): void {
    this.w(`  ${C.bgreen}✓${R} ${msg}\n`)
  }

  error(msg: string): void {
    this.w(`\n  ${C.bred}✗ ${msg}${R}\n`)
  }

  warn(msg: string): void {
    if (!msg.trim()) return
    this.w(`  ${C.byellow}⚠${R} ${msg}\n`)
  }

  // ── Sub-agent ─────────────────────────────────────────────

  agentStart(desc: string, type = 'general-purpose'): void {
    const label = type !== 'general-purpose' ? ` ${D}[${C.bpurple}${type}${R}${D}]${R}` : ''
    this.w(`\n  ${C.bpurple}⊕${R} ${B}Agent${R}${label} ${D}${desc}${R}\n`)
  }

  agentDone(desc: string, ok: boolean): void {
    this.w(`  ${ok ? C.bgreen + '✓' : C.bred + '✗'}${R} ${D}done${R}\n`)
  }

  agentSummary(type: string, desc: string, summary: string): void {
    const lines = summary.split('\n').filter(l => l.trim()).slice(0, 6)
    for (const line of lines) {
      this.w(`    ${D}${line}${R}\n`)
    }
  }

  agentHeartbeat(type: string, desc: string, sec: number): void {
    const m = Math.floor(sec / 60)
    const s = sec % 60
    const t = m > 0 ? `${m}m${s}s` : `${s}s`
    this.w(`  ${C.yellow}⏳${R} ${D}[${type}] ${t}...${R}\n`)
  }

  // ── Context ───────────────────────────────────────────────

  compactStart(tokens: number): void {
    this.w(`\n  ${C.yellow}⟳${R} ${D}Context ${Math.round(tokens / 1000)}k — compacting...${R}\n`)
  }

  compactDone(orig: number, sum: number): void {
    const pct = Math.round((1 - sum / orig) * 100)
    this.w(`  ${C.bgreen}✓${R} ${D}${Math.round(orig / 1000)}k → ${Math.round(sum / 1000)}k (${pct}% saved)${R}\n`)
  }

  contextWarning(tokens: number, max: number, pct: number): void {
    const p = Math.round(pct * 100)
    this.w(`\n  ${C.byellow}⚠${R} ${D}Context ${p}% (${Math.round(tokens / 1000)}k/${Math.round(max / 1000)}k)${R}\n`)
  }

  // ── Plan mode ─────────────────────────────────────────────

  planModeStart(): void {
    this.w(`\n  ${C.bblue}◆ PLAN MODE${R} ${D}(read-only analysis)${R}\n`)
    this.w(`  ${this.hr()}\n`)
  }

  planConfirmPrompt(): void {
    this.w(`\n  ${C.byellow}?${R} Proceed? ${D}[y/N]${R} `)
  }

  // ── Interrupt ─────────────────────────────────────────────

  writeInterruptPrompt(): void {
    this.w('\n\x07')
    this.w(`  ${this.hr()}\n`)
    this.w(`  ${C.byellow}⚡ Interrupted${R}\n`)
    this.w(`  ${D}Feedback + Enter to inject · Enter to resume${R}\n`)
    this.w(`  ${C.byellow}❯${R} `)
  }

  interruptInjected(msg: string): void {
    this.w(`  ${C.byellow}⚡${R} ${C.white}${msg.slice(0, 120)}${R}\n`)
  }

  // ── REPL ──────────────────────────────────────────────────

  writePrompt(): void {
    this.w(`\n  ${C.bblue}❯${R} `)
  }

  newline(): void {
    this.w('\n')
  }
}
