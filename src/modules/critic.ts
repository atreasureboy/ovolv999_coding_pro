/**
 * CriticModule — self-correction loop.
 *
 * Every N iterations, runs a lightweight LLM call to review recent
 * conversation history for common failure modes. If issues are found,
 * returns a correction message to inject.
 *
 * Extracted from engine.ts (maybeRunCritic + critic invocation in loop).
 */

import type OpenAI from 'openai'
import type { AgentModule, ModuleBootResult, ModuleIterationContext, ModuleIterationResult } from '../core/module.js'
import {
  CRITIC_INTERVAL,
  CRITIC_MIN_ITERATIONS,
  CRITIC_CONTEXT_MESSAGES,
  CRITIC_MAX_TOKENS,
  DEFAULT_CRITIC_SYSTEM_PROMPT,
  formatMessagesForCritic,
  parseCriticOutput,
} from '../prompts/critic.js'

export class CriticModule implements AgentModule {
  readonly name = 'critic'

  constructor(
    private client: OpenAI,
    private model: string,
    private config: { planMode?: boolean; poor?: { enabled: boolean } },
  ) {}

  boot(): ModuleBootResult {
    return {}
  }

  /**
   * P0-1 (transactional model switch): keep the captured model in
   * sync with the runtime so the periodic critic LLM call targets
   * the user's currently-selected model rather than the model that
   * was active when this module was constructed.
   */
  onModelChanged(model: string): void {
    this.model = model
  }

  async onIteration(ctx: ModuleIterationContext): Promise<ModuleIterationResult | void> {
    if (this.config.planMode) return
    if (this.config.poor?.enabled) return
    if (ctx.iteration < CRITIC_MIN_ITERATIONS) return
    // v0.3.1 (te_goal §六.3): single-track critic. Run on the fixed
    // interval OR immediately when the coordinator detected risk
    // (ctx.criticRequested). This replaces the old "always every-N"
    // behaviour — no tokens wasted on healthy runs.
    if (ctx.iteration % CRITIC_INTERVAL !== 0 && !ctx.criticRequested) return

    const recent = ctx.messages.slice(-CRITIC_CONTEXT_MESSAGES)
    if (recent.length < 4) return

    try {
      const response = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: [
            { role: 'system', content: DEFAULT_CRITIC_SYSTEM_PROMPT },
            {
              role: 'user',
              content: `Review the following recent action history for mistakes:\n\n${formatMessagesForCritic(recent)}`,
            },
          ],
          temperature: 0,
          max_tokens: CRITIC_MAX_TOKENS,
        },
        { signal: ctx.abortSignal },
      )

      const output = response.choices[0]?.message?.content ?? ''
      const criticism = parseCriticOutput(output)

      if (criticism) {
        return {
          injectMessage: `[Critic Check]\n${criticism}\n\nAdjust your actions based on the above feedback immediately.`,
        }
      }
    } catch {
      // critic failures must never break the main loop
    }
  }
}
