/**
 * Tool descriptions — Claude Code-level detail for coding tools.
 */

export const BASH_DESCRIPTION = `Executes a bash command and returns its output (stdout + stderr combined).

The working directory persists between calls via absolute paths. Shell state (variables, aliases) does NOT persist.

IMPORTANT: Avoid using this for file operations when dedicated tools exist:
- File search: Use Glob (NOT find or ls)
- Content search: Use Grep (NOT grep or rg)
- Read files: Use Read (NOT cat/head/tail)
- Edit files: Use Edit (NOT sed/awk)
- Write files: Use Write (NOT echo > or cat <<EOF)

Reserve Bash for: build tools, test runners, git operations, system commands, scripts.

## Timeout Strategy

Default timeout: **1800 seconds (30 min)**. Max: **14400 seconds (4 hours)**.

Always set an explicit timeout for long-running commands based on expected duration:
- Quick commands (ls, git status): default is fine
- Build / compile: timeout=300000
- Test suites: timeout=600000

## Background Pattern

For commands expected to run >5 minutes, ALWAYS use background mode:

\`\`\`
run_in_background=true
command: "npm run build > /tmp/build.log 2>&1"

# Step 2 (later): Check progress
command: "tail -50 /tmp/build.log"

# Or wait for completion
command: "wait && cat /tmp/build.log"
\`\`\`

## Parallel Execution

To run multiple commands simultaneously, call Bash multiple times with run_in_background=true in the SAME response.

Example: Run build + lint + test all at once:
- Call 1: build → /tmp/build.log (background)
- Call 2: lint → /tmp/lint.log (background)
- Call 3: test → /tmp/test.log (background)
Then in next turn: read all three output files.

## Git Safety Protocol

- NEVER update the git config
- NEVER run destructive git commands (push --force, reset --hard, clean -f) unless explicitly requested
- NEVER skip hooks (--no-verify) unless explicitly requested
- NEVER force push to main/master
- Always create NEW commits rather than amending (amending after hook failure can destroy work)
- When staging files, prefer specific filenames over \`git add -A\` (avoid committing secrets)
- NEVER commit unless the user explicitly asks

## Other Instructions
- Always quote paths with spaces: "path with spaces/file.txt"
- Use absolute paths; avoid cd
- For dependent sequential commands, chain with && in one call`

export const READ_FILE_DESCRIPTION = `Reads a file from the local filesystem. You can access any file directly by using this tool.

Usage:
- The file_path parameter must be an absolute path
- By default, reads up to 2000 lines starting from the beginning of the file
- Optionally specify offset (start line) and limit (number of lines) for large files
- Results are returned with line numbers starting at 1
- Can read text files, code files, JSON, YAML, etc.
- Binary files are detected and not displayed (use Bash with xxd/strings)
- If the file is larger than the limit, a hint shows how to read the next page

IMPORTANT: You MUST read a file before you can Edit or Write to it. The Edit and Write tools will fail if you have not read the file first in this session.`

export const WRITE_FILE_DESCRIPTION = `Writes content to a file, creating it if it doesn't exist or overwriting if it does.

Usage:
- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.
- Prefer the Edit tool for modifying existing files — it only sends the diff. Only use this tool to create new files or for complete rewrites.
- NEVER create documentation files (*.md) or README files unless explicitly requested.

Always read the file first before overwriting to avoid losing content.`

export const EDIT_FILE_DESCRIPTION = `Performs exact string replacements in files.

Usage:
- You must use the Read tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: line number + tab. Everything after that is the actual file content to match.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- The edit will FAIL if \`old_string\` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use \`replace_all\` to change every instance of \`old_string\`.
- Use \`replace_all\` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.
- After editing, the tool auto-formats with prettier/eslint if detected in the project.
- A diff showing changed lines (- old / + new) is displayed after each edit.

This is the preferred way to modify existing files — it's precise and shows exactly what changed.`

export const GLOB_DESCRIPTION = `Finds files matching a glob pattern, sorted by modification time (newest first).

- Fast file pattern matching that works with any codebase size
- Supports glob patterns like "**/*.ts" or "src/**/*.{js,ts}"
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns
- For open-ended searches requiring multiple rounds, use the Agent tool instead

Examples:
- "**/*.ts" — all TypeScript files recursively
- "src/**/*.{js,ts}" — JS/TS files under src/
- "*.json" — JSON files in current directory`

export const GREP_DESCRIPTION = `Searches file contents using regex patterns (powered by ripgrep).

Usage:
- ALWAYS use Grep for search tasks. NEVER invoke \`grep\` or \`rg\` as a Bash command.
- Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
- Filter files with the \`glob\` parameter (e.g., "*.ts", "**/*.tsx") or \`include\` shorthand (e.g., "ts", "py")
- Output modes: "content" shows matching lines with line numbers, "files_with_matches" (default) shows file paths, "count" shows match counts
- Use the Agent tool for open-ended searches requiring multiple rounds

Parameters:
- pattern: regex pattern to search for
- path: directory or file to search (defaults to cwd)
- glob: file pattern filter (e.g. "*.ts")
- include: file extension shorthand (e.g. "ts" → glob "*.ts")
- output_mode: "files_with_matches" (default) | "content" | "count"
- context: lines of context around matches (when output_mode="content")
- case_insensitive: true/false

Examples:
- Find files containing "useEffect": pattern="useEffect", glob="*.tsx"
- Show matching lines: pattern="TODO", output_mode="content"
- Count matches: pattern="console.log", output_mode="count"
- Search only TypeScript: pattern="import", include="ts"`
