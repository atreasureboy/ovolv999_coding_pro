import { describe, expect, it } from 'vitest'
import { AGENT_PRESETS } from '../src/core/agentPresets.js'
import { getSystemPrompt } from '../src/prompts/system.js'

describe('agent instruction priority', () => {
  it('defines P0, P1, and P2 semantics in the main agent prompt', () => {
    const prompt = getSystemPrompt('/workspace')
    expect(prompt).toContain('## P0 — MUST / MUST NOT')
    expect(prompt).toContain('## P1 — SHOULD / SHOULD NOT')
    expect(prompt).toContain('## P2 — PREFER / AVOID')
    expect(prompt).toContain('MUST continue through all necessary safe, in-scope steps without asking whether to continue')
    expect(prompt).not.toContain("After editing files: stop")
  })

  it('applies completion priority to every built-in sub-agent preset', () => {
    for (const preset of Object.values(AGENT_PRESETS)) {
      const prompt = preset.identity.systemPrompt('/workspace')
      expect(prompt).toContain('P0 MUST')
      expect(prompt).toContain('never ask whether to continue')
      expect(prompt).toContain('never claim partial work is complete')
    }
  })
})
