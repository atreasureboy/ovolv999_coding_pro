/**
 * builtin.ts — entry for the built-in slash commands.
 *
 * Round 29: this file was 3,800+ lines registering ~90 commands with 40+
 * lazy requires. It is now a thin barrel: the groups under ./cmd/ register
 * their commands on import (side-effectful, same contract as before), and
 * the worker-manager test hooks are re-exported for existing test imports.
 */

// Group registration (side-effectful — order is irrelevant, the registry
// is a map keyed by command name)
import './cmd/group01.js'
import './cmd/group02.js'
import './cmd/group03.js'
import './cmd/group04.js'
import './cmd/group05.js'
import './cmd/group06.js'
import './cmd/group07.js'

// Test-facing hooks (tests import these from commands/builtin.js)
export { setWorkerManager, resetWorkerManager } from './shared.js'
