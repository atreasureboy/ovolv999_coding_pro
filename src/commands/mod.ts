/**
 * Slash Command Framework — re-export from index.ts
 */
export {
  registerCommand,
  getCommand,
  listCommands,
  clearRegistry,
  dispatchSlashCommand,
  type Command,
  type SlashCommandContext,
  type SlashCommandResult,
} from './index.js'

// Import to register all built-in commands
import './builtin.js'
