/**
 * WorkspaceModule — session directory for artifacts.
 *
 * Provides sessionDir to ToolContext so tools can write outputs
 * (generated files, logs, reports) to an isolated per-session directory.
 */

import { existsSync, mkdirSync } from 'fs'
import type { AgentModule, ModuleBootContext, ModuleBootResult } from '../core/module.js'

export class WorkspaceModule implements AgentModule {
  readonly name = 'workspace'

  constructor(private sessionDir?: string) {}

  boot(ctx: ModuleBootContext): ModuleBootResult {
    const sessionDir = this.sessionDir ?? ctx.sessionDir
    if (sessionDir && !existsSync(sessionDir)) {
      try { mkdirSync(sessionDir, { recursive: true }) } catch { /* best-effort */ }
    }
    return {
      toolContextPatch: sessionDir ? { sessionDir } : {},
    }
  }
}
