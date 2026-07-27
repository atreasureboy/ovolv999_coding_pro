import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

export interface LoopScaffoldResult {
  created: string[]
  preserved: string[]
  acceptanceCount: number
}

function packageScripts(cwd: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    return parsed.scripts ?? {}
  } catch {
    return {}
  }
}

function acceptanceCommands(cwd: string): Array<{ label: string; command: string }> {
  const scripts = packageScripts(cwd)
  const selected = ['typecheck', 'lint', 'test', 'build']
    .filter(name => Boolean(scripts[name]))
    .map(name => ({ label: `${name} passes`, command: `npm run ${name}` }))
  if (selected.length > 0) return selected
  if (existsSync(join(cwd, 'pyproject.toml'))) {
    return [{ label: 'Python tests pass', command: 'python -m pytest' }]
  }
  if (existsSync(join(cwd, 'go.mod'))) {
    return [{ label: 'Go tests pass', command: 'go test ./...' }]
  }
  if (existsSync(join(cwd, 'Cargo.toml'))) {
    return [{ label: 'Rust tests pass', command: 'cargo test' }]
  }
  return []
}

function writeMissing(path: string, content: string, created: string[], preserved: string[]): void {
  if (existsSync(path)) {
    preserved.push(path)
    return
  }
  writeFileSync(path, content, 'utf8')
  created.push(path)
}

export function initializeLoopWorkspace(cwd: string, goal: string): LoopScaffoldResult {
  const loopDir = join(cwd, '.loop')
  const skillsDir = join(loopDir, 'skills')
  mkdirSync(skillsDir, { recursive: true })
  const created: string[] = []
  const preserved: string[] = []
  const commands = acceptanceCommands(cwd)
  const acceptance = commands.length > 0
    ? commands.map((item, index) => `- [ ] A${index + 1}: ${item.label} \`${item.command}\``).join('\n')
    : '- [ ] A1: Replace this criterion with a verifiable project command'

  writeMissing(join(loopDir, 'GOAL.md'), `# Goal\n\n${goal.trim()}\n`, created, preserved)
  writeMissing(join(loopDir, 'ACCEPTANCE.md'), `# Acceptance\n\n${acceptance}\n`, created, preserved)
  writeMissing(join(loopDir, 'STATE.md'), '# State\n\nNot started.\n', created, preserved)
  writeMissing(join(loopDir, 'HISTORY.md'), '# History\n', created, preserved)
  writeMissing(join(skillsDir, 'CONVENTIONS.md'), '# Conventions\n\nFollow the project instructions and neighboring code patterns.\n', created, preserved)
  writeMissing(join(skillsDir, 'COMMANDS.md'), `# Commands\n\n${commands.map(item => `- ${item.command}`).join('\n') || '- Add project verification commands here.'}\n`, created, preserved)
  writeMissing(join(skillsDir, 'PITFALLS.md'), '# Pitfalls\n\n- Record project-specific hazards discovered during the loop.\n', created, preserved)

  return { created, preserved, acceptanceCount: commands.length }
}
