/**
 * ProjectExplorerTool — exposes project exploration to the agent model.
 *
 * The agent can call this to discover the project's structure, languages,
 * frameworks, entry points, and build system. This is useful at the start
 * of a session so the agent knows what kind of project it's working with.
 */

import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../core/types.js'
import { exploreProject, formatProjectOverview } from '../core/projectExplorer.js'

export class ProjectExplorerTool implements Tool {
  name = 'ProjectExplorer'
  metadata = {
    readOnly: true,
    concurrencySafe: true,
    searchHint: 'explore discover project structure languages frameworks overview',
  }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'ProjectExplorer',
      description: `Explore the project structure to discover languages, frameworks, entry points, and build systems.

Use this at the start of a session to understand the codebase before making changes.
Returns a structured overview including:
- Languages and their file counts
- Frameworks and libraries detected
- Build system and package manager
- Entry points (main files, CLI binaries)
- Config files present
- Whether the project has tests, git, CI

This is a read-only tool — it does not modify any files.`,
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  }

  async execute(
    _input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const cwd = (context as { cwd?: string }).cwd ?? process.cwd()
    const overview = exploreProject(cwd)
    return {
      content: formatProjectOverview(overview),
      isError: false,
    }
  }
}