/**
 * ModuleRegistry — manages module factories and resolves enabled modules.
 *
 * Usage:
 *   const registry = new ModuleRegistry()
 *   registry.register('memory', (ctx) => new MemoryModule(ctx.config.semanticMemory!, ...))
 *   const modules = registry.resolve(['memory', 'critic'], moduleCtx)
 */

import type { AgentModule, ModuleFactory, ModuleContext } from './module.js'

export class ModuleRegistry {
  private factories = new Map<string, ModuleFactory>()

  /** Register a module factory by name */
  register(name: string, factory: ModuleFactory): void {
    this.factories.set(name, factory)
  }

  /** Check if a module is registered */
  has(name: string): boolean {
    return this.factories.has(name)
  }

  /**
   * Resolve a list of enabled module names into instantiated modules.
   * Dependencies are resolved automatically (depth-first, deduplicated).
   */
  resolve(enabledNames: string[], ctx: ModuleContext): AgentModule[] {
    const resolved: AgentModule[] = []
    const seen = new Set<string>()
    const inProgress = new Set<string>()  // cycle detection

    const resolveOne = (name: string): void => {
      if (seen.has(name)) return
      if (inProgress.has(name)) {
        // Cycle detected — refuse to resolve (five_goal §十二 P2-1).
        throw new Error(
          `[moduleRegistry] circular dependency detected while resolving "${name}" — refusing to boot`,
        )
      }
      const factory = this.factories.get(name)
      if (!factory) return

      inProgress.add(name)
      const module = factory(ctx)

      // Resolve dependencies first
      for (const dep of module.dependencies ?? []) {
        resolveOne(dep)
      }

      inProgress.delete(name)
      seen.add(name)
      resolved.push(module)
    }

    for (const name of enabledNames) {
      resolveOne(name)
    }

    return resolved
  }
}

/** Global default registry — populated at startup by bin/ovogogogo.ts */
export const globalModuleRegistry = new ModuleRegistry()
