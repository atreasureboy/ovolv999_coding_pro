/**
 * First-run config wizard (`ovolv999 init`).
 *
 * Interactive provider setup for users without Claude Code or env vars.
 * Detection order, first match wins:
 *   1. ~/.claude/settings.json  → offer to reuse (MiniMax M3 etc.) zero-config
 *   2. OPENAI_API_KEY env        → offer OpenAI
 *   3. nothing                   → manual: pick a provider preset + enter key
 *
 * Writes the user-level provider config to ~/.ovogo/settings.json via
 * saveGlobalProvider(). resolveApiEnvironment reads it (process env still
 * wins; this beats the Claude fallback).
 */

import { createInterface } from 'readline'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { saveGlobalProvider, type ProviderConfig } from './settings.js'

type Color = (s: string) => string
const makeColor = (code: string): Color => (s: string) => `\x1b[${code}m${s}\x1b[0m`
const c = {
  cyan: makeColor('36'), green: makeColor('32'), yellow: makeColor('33'),
  dim: makeColor('2'), bold: makeColor('1'), red: makeColor('31'),
}

interface WizardIO {
  ask: (q: string, def?: string) => Promise<string>
  say: (s: string) => void
}

function makeIO(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): WizardIO {
  const rl = createInterface({ input, output })
  return {
    ask: (q: string, def?: string) => new Promise((resolve) => {
      const suffix = def !== undefined ? c.dim(` [${def}]`) : ''
      rl.question(`${q}${suffix} `, (ans) => {
        const trimmed = ans.trim()
        resolve(trimmed === '' && def !== undefined ? def : trimmed)
      })
    }),
    say: (s: string) => output.write(s + '\n'),
  }
}

/** Read the env block from ~/.claude/settings.json if present. */
function readClaudeEnv(): Record<string, string> | null {
  try {
    const raw = readFileSync(`${homedir()}/.claude/settings.json`, 'utf8')
    const env = (JSON.parse(raw) as { env?: Record<string, string> }).env
    return env && typeof env === 'object' ? env : null
  } catch {
    return null
  }
}

const MINIMAX_RE = /^https:\/\/api\.(?:minimax\.io|minimaxi\.com)\/anthropic\/?$/i

export async function runFirstRunWizard(opts: {
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
}): Promise<{ configured: boolean; provider?: ProviderConfig }> {
  const io = makeIO(opts.input ?? process.stdin, opts.output ?? process.stdout)
  const out = (s: string) => io.say(s)

  out('')
  out(c.bold(c.cyan('  ovolv999 — first-run setup')))
  out(c.dim('  Configure which LLM provider ovolv999 talks to.'))
  out('')

  // ── 1. Claude Code reuse ───────────────────────────────────────
  const claudeEnv = readClaudeEnv()
  if (claudeEnv?.ANTHROPIC_BASE_URL && (claudeEnv.ANTHROPIC_AUTH_TOKEN || claudeEnv.ANTHROPIC_API_KEY)) {
    const isMm = MINIMAX_RE.test(claudeEnv.ANTHROPIC_BASE_URL)
    const model = claudeEnv.ANTHROPIC_MODEL ?? (isMm ? 'MiniMax-M3' : undefined)
    out(`Detected Claude Code config (${isMm ? 'MiniMax' : 'Anthropic facade'}${model ? ': ' + model : ''}).`)
    const reuse = await io.ask('Reuse it so ovolv999 shares the same account, zero API-key entry?', 'Y')
    if (/^y(es)?$/i.test(reuse)) {
      const provider: ProviderConfig = isMm
        ? {
            provider: 'minimax',
            apiKey: claudeEnv.ANTHROPIC_AUTH_TOKEN ?? claudeEnv.ANTHROPIC_API_KEY,
            baseURL: claudeEnv.ANTHROPIC_BASE_URL.replace(/\/anthropic\/?$/i, '/v1'),
            model: (model ?? 'MiniMax-M3').replace(/\[[^\]]*\]$/, ''),
          }
        : {
            provider: 'anthropic',
            apiKey: claudeEnv.ANTHROPIC_AUTH_TOKEN ?? claudeEnv.ANTHROPIC_API_KEY,
            baseURL: claudeEnv.ANTHROPIC_BASE_URL,
            model,
          }
      saveGlobalProvider(provider)
      out(c.green('  ✓ saved. Run `ovolv999` to start.'))
      return { configured: true, provider }
    }
    out('')
  }

  // ── 2. OpenAI env ──────────────────────────────────────────────
  if (process.env.OPENAI_API_KEY) {
    out('Detected OPENAI_API_KEY in your environment.')
    const use = await io.ask('Use OpenAI with it?', 'Y')
    if (/^y(es)?$/i.test(use)) {
      const model = await io.ask('Model', 'gpt-4o')
      const provider: ProviderConfig = {
        provider: 'openai',
        apiKey: process.env.OPENAI_API_KEY,
        baseURL: process.env.OPENAI_BASE_URL,
        model,
      }
      saveGlobalProvider(provider)
      out(c.green('  ✓ saved. Run `ovolv999` to start.'))
      return { configured: true, provider }
    }
    out('')
  }

  // ── 3. Manual ──────────────────────────────────────────────────
  out('Pick a provider preset:')
  out(c.dim('  1) OpenAI / OpenAI-compatible (OpenRouter, Together, Groq, DeepSeek, Ollama, …)'))
  out(c.dim('  2) MiniMax (M3)'))
  out(c.dim('  3) Anthropic-compatible facade'))
  const choice = await io.ask('Choice', '1')
  const preset = choice === '2' ? 'minimax' : choice === '3' ? 'anthropic' : 'openai'

  const apiKey = await io.ask('API key')
  if (!apiKey) { out(c.red('  ✗ API key is required. Re-run `ovolv999 init`.')); return { configured: false } }
  let baseURL: string | undefined
  let model: string | undefined
  if (preset === 'minimax') {
    baseURL = 'https://api.minimax.io/v1'
    model = await io.ask('Model', 'MiniMax-M3')
  } else if (preset === 'anthropic') {
    baseURL = await io.ask('Base URL (Anthropic facade)')
    model = await io.ask('Model')
  } else {
    baseURL = await io.ask('Base URL (blank for https://api.openai.com/v1)', '')
    baseURL = baseURL || undefined
    model = await io.ask('Model', 'gpt-4o')
  }
  const provider: ProviderConfig = { provider: preset, apiKey, baseURL, model }
  saveGlobalProvider(provider)
  out('')
  out(c.green('  ✓ saved to ~/.ovogo/settings.json'))
  out(c.dim('  Run `ovolv999` to start. Edit ~/.ovogo/settings.json to change later.'))
  return { configured: true, provider }
}
