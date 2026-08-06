import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  detectCategory,
  extractToolSequence,
  generateSkillPrompt,
  formatSkillMarkdown,
  extractSkill,
  saveSkill,
  skillExists,
  type OpenAIMessage,
} from '../src/skills/extractor.js'

// ── Helpers ─────────────────────────────────────────────────────────────────

function userMsg(text: string): OpenAIMessage {
  return { role: 'user', content: text }
}

function assistantMsg(text: string, toolCalls?: unknown[]): OpenAIMessage {
  const msg: OpenAIMessage = { role: 'assistant', content: text }
  if (toolCalls) {
    msg.tool_calls = toolCalls as OpenAIMessage['tool_calls']
  }
  return msg
}

function toolCall(name: string, args: Record<string, unknown>): unknown {
  return {
    id: `call_${name}_${Math.random()}`,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  }
}

// ── Category Detection ──────────────────────────────────────────────────────

describe('detectCategory', () => {
  it('detects bug-fix', () => {
    expect(detectCategory([userMsg('fix the bug in the login')])).toBe('bug-fix')
    expect(detectCategory([userMsg('there is an error in the parser')])).toBe('bug-fix')
    expect(detectCategory([userMsg('the app crashes on startup')])).toBe('bug-fix')
  })

  it('detects feature', () => {
    expect(detectCategory([userMsg('add a new feature for export')])).toBe('feature')
    expect(detectCategory([userMsg('implement user authentication')])).toBe('feature')
    expect(detectCategory([userMsg('create a new API endpoint')])).toBe('feature')
  })

  it('detects refactor', () => {
    expect(detectCategory([userMsg('refactor the database layer')])).toBe('refactor')
    expect(detectCategory([userMsg('clean up the utility functions')])).toBe('refactor')
    expect(detectCategory([userMsg('simplify the retry logic')])).toBe('refactor')
  })

  it('detects test', () => {
    expect(detectCategory([userMsg('write tests for the parser')])).toBe('test')
    expect(detectCategory([userMsg('add test coverage for utils')])).toBe('test')
  })

  it('detects docs', () => {
    expect(detectCategory([userMsg('document the API')])).toBe('docs')
    expect(detectCategory([userMsg('update the README')])).toBe('docs')
  })

  it('detects review', () => {
    expect(detectCategory([userMsg('review this code')])).toBe('review')
    expect(detectCategory([userMsg('audit the security')])).toBe('review')
  })

  it('detects explore', () => {
    expect(detectCategory([userMsg('explore the codebase')])).toBe('explore')
    expect(detectCategory([userMsg('how does the parser work')])).toBe('explore')
  })

  it('detects config', () => {
    expect(detectCategory([userMsg('configure the tsconfig')])).toBe('config')
    expect(detectCategory([userMsg('setup the environment')])).toBe('config')
  })

  it('returns unknown for empty', () => {
    expect(detectCategory([])).toBe('unknown')
  })

  it('handles multiple keywords (picks highest score)', () => {
    const msgs = [userMsg('fix the bug and add a new feature')]
    // Both 'bug-fix' and 'feature' score 1 — first one wins
    const result = detectCategory(msgs)
    expect(['bug-fix', 'feature']).toContain(result)
  })
})

// ── Tool Sequence Extraction ────────────────────────────────────────────────

describe('extractToolSequence', () => {
  it('extracts tool calls from assistant messages', () => {
    const msgs: OpenAIMessage[] = [
      userMsg('do something'),
      assistantMsg('ok', [
        toolCall('Read', { file_path: '/test/foo.ts' }),
        toolCall('Bash', { command: 'npm test' }),
      ]),
    ]
    const seq = extractToolSequence(msgs)
    expect(seq).toHaveLength(2)
    expect(seq[0].name).toBe('Read')
    expect(seq[0].summary).toBe('/test/foo.ts')
    expect(seq[1].name).toBe('Bash')
    expect(seq[1].summary).toBe('npm test')
  })

  it('ignores messages without tool calls', () => {
    const msgs: OpenAIMessage[] = [
      userMsg('hello'),
      assistantMsg('hi there'),
    ]
    expect(extractToolSequence(msgs)).toEqual([])
  })

  it('handles multiple turns', () => {
    const msgs: OpenAIMessage[] = [
      userMsg('turn 1'),
      assistantMsg('r1', [toolCall('Read', { file_path: 'a.ts' })]),
      userMsg('turn 2'),
      assistantMsg('r2', [toolCall('Edit', { file_path: 'a.ts' }), toolCall('Bash', { command: 'tsc' })]),
    ]
    const seq = extractToolSequence(msgs)
    expect(seq).toHaveLength(3)
    expect(seq[1].name).toBe('Edit')
    expect(seq[2].name).toBe('Bash')
  })

  it('summarizes various tool types', () => {
    const msgs: OpenAIMessage[] = [
      assistantMsg('', [
        toolCall('Grep', { pattern: 'function.*test' }),
        toolCall('Glob', { pattern: '**/*.ts' }),
        toolCall('Agent', { description: 'explore tests' }),
        toolCall('WebSearch', { query: 'how to test' }),
      ]),
    ]
    const seq = extractToolSequence(msgs)
    expect(seq[0].summary).toBe('function.*test')
    expect(seq[1].summary).toBe('**/*.ts')
    expect(seq[2].summary).toContain('explore')
    expect(seq[3].summary).toContain('how to test')
  })

  it('handles malformed tool call arguments', () => {
    const msgs = [{
      role: 'assistant' as const,
      content: '',
      tool_calls: [{ id: 'x', type: 'function' as const, function: { name: 'Read', arguments: '{invalid json' } }],
    }] as OpenAIMessage[]
    const seq = extractToolSequence(msgs)
    expect(seq).toHaveLength(1)
    expect(seq[0].summary).toBe('')
  })
})

// ── Prompt Generation ───────────────────────────────────────────────────────

describe('generateSkillPrompt', () => {
  it('generates markdown with title and task', () => {
    const extraction = {
      name: 'fix-lint',
      description: 'Fix linting errors',
      category: 'bug-fix' as const,
      toolSequence: [],
      messageCount: 10,
      turnCount: 3,
      prompt: '',
    }
    extraction.prompt = generateSkillPrompt(extraction)
    expect(extraction.prompt).toContain('# Fix Lint')
    expect(extraction.prompt).toContain('$ARGS')
    expect(extraction.prompt).toContain('## Task')
  })

  it('includes tool sequence as steps', () => {
    const extraction = {
      name: 'add-test',
      description: 'Add tests',
      category: 'test' as const,
      toolSequence: [
        { name: 'Read', summary: 'src/foo.ts' },
        { name: 'Bash', summary: 'npm test' },
      ],
      messageCount: 5,
      turnCount: 2,
      prompt: '',
    }
    extraction.prompt = generateSkillPrompt(extraction)
    expect(extraction.prompt).toContain('## Approach')
    expect(extraction.prompt).toContain('Read src/foo.ts')
    expect(extraction.prompt).toContain('Run npm test')
  })

  it('deduplicates consecutive same-tool calls', () => {
    const extraction = {
      name: 'read-many',
      description: 'Read multiple files',
      category: 'explore' as const,
      toolSequence: [
        { name: 'Read', summary: 'a.ts' },
        { name: 'Read', summary: 'b.ts' },
        { name: 'Read', summary: 'c.ts' },
      ],
      messageCount: 5,
      turnCount: 1,
      prompt: '',
    }
    extraction.prompt = generateSkillPrompt(extraction)
    expect(extraction.prompt).toContain('3 items')
  })

  it('includes category-specific tips', () => {
    const extraction = {
      name: 'fix-bug',
      description: 'Fix a bug',
      category: 'bug-fix' as const,
      toolSequence: [],
      messageCount: 5,
      turnCount: 1,
      prompt: '',
    }
    extraction.prompt = generateSkillPrompt(extraction)
    expect(extraction.prompt).toContain('## Tips')
    expect(extraction.prompt).toContain('Reproduce the bug')
  })

  it('omits tips for unknown category', () => {
    const extraction = {
      name: 'misc',
      description: 'Misc',
      category: 'unknown' as const,
      toolSequence: [],
      messageCount: 1,
      turnCount: 1,
      prompt: '',
    }
    extraction.prompt = generateSkillPrompt(extraction)
    expect(extraction.prompt).not.toContain('## Tips')
  })
})

// ── Full Extraction ─────────────────────────────────────────────────────────

describe('extractSkill', () => {
  it('extracts a complete skill from messages', () => {
    const msgs: OpenAIMessage[] = [
      userMsg('fix the bug in auth'),
      assistantMsg('let me check', [
        toolCall('Read', { file_path: 'src/auth.ts' }),
        toolCall('Edit', { file_path: 'src/auth.ts' }),
        toolCall('Bash', { command: 'npm test' }),
      ]),
      assistantMsg('done'),
    ]
    const result = extractSkill(msgs, { name: 'fix-auth-bug' })
    expect(result.name).toBe('fix-auth-bug')
    expect(result.category).toBe('bug-fix')
    expect(result.toolSequence).toHaveLength(3)
    expect(result.turnCount).toBe(1)
    expect(result.prompt).toContain('# Fix Auth Bug')
    expect(result.prompt).toContain('$ARGS')
  })

  it('respects maxMessages limit', () => {
    const msgs: OpenAIMessage[] = []
    for (let i = 0; i < 100; i++) {
      msgs.push(userMsg(`message ${i}`))
    }
    const result = extractSkill(msgs, { name: 'test', maxMessages: 10 })
    expect(result.messageCount).toBe(10)
  })

  it('uses custom description', () => {
    const msgs = [userMsg('do something')]
    const result = extractSkill(msgs, { name: 'test', description: 'Custom description' })
    expect(result.description).toBe('Custom description')
  })

  it('generates description from first user message', () => {
    const msgs = [userMsg('Fix the critical authentication bug in the login flow')]
    const result = extractSkill(msgs, { name: 'test' })
    expect(result.description).toContain('Fix the critical')
  })
})

// ── Serialization ───────────────────────────────────────────────────────────

describe('formatSkillMarkdown', () => {
  it('produces YAML frontmatter', () => {
    const extraction = {
      name: 'my-skill',
      description: 'A test skill',
      category: 'feature' as const,
      toolSequence: [],
      messageCount: 1,
      turnCount: 1,
      prompt: '# My Skill\n\nDo stuff\n',
    }
    const md = formatSkillMarkdown(extraction)
    expect(md).toContain('---')
    expect(md).toContain('name: my-skill')
    expect(md).toContain('description: A test skill')
    expect(md).toContain('category: feature')
    expect(md).toContain('# My Skill')
  })
})

// ── Save & Exists ───────────────────────────────────────────────────────────

describe('saveSkill & skillExists', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skill-'))
  })

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('saves skill to .ovogo/skills/', () => {
    const extraction = {
      name: 'test-skill',
      description: 'Test',
      category: 'test' as const,
      toolSequence: [],
      messageCount: 1,
      turnCount: 1,
      prompt: '# Test\n',
    }
    const path = saveSkill(dir, extraction)
    expect(path).toContain('.ovogo')
    expect(path).toContain('test-skill.md')
    expect(existsSync(path)).toBe(true)

    const content = readFileSync(path, 'utf8')
    expect(content).toContain('name: test-skill')
  })

  it('skillExists returns true after save', () => {
    expect(skillExists(dir, 'new')).toBe(false)
    saveSkill(dir, {
      name: 'new', description: 'x', category: 'unknown',
      toolSequence: [], messageCount: 1, turnCount: 1, prompt: '',
    })
    expect(skillExists(dir, 'new')).toBe(true)
  })

  it('creates the skills directory if needed', () => {
    const path = saveSkill(dir, {
      name: 'fresh', description: 'x', category: 'unknown',
      toolSequence: [], messageCount: 1, turnCount: 1, prompt: '',
    })
    expect(existsSync(path)).toBe(true)
  })
})
