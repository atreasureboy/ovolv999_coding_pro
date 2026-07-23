#!/usr/bin/env bash
# ================================================================
#  ovolv999 — one-line installer (macOS / Linux)
#
#  Install:   curl -fsSL https://raw.githubusercontent.com/atreasureboy/ovolv999_coding_pro/main/install.sh | bash
#  Update:    curl -fsSL https://raw.githubusercontent.com/atreasureboy/ovolv999_coding_pro/main/install.sh | bash -s -- --update
#  Uninstall: curl -fsSL https://raw.githubusercontent.com/atreasureboy/ovolv999_coding_pro/main/install.sh | bash -s -- --uninstall
#
#  Clones the repo to ~/.ovolv999, installs deps, builds, and symlinks
#  `ovolv999` onto your PATH. Re-running updates in place. If Claude
#  Code is configured (~/.claude/settings.json) the provider is reused
#  zero-config — no API key entry needed.
# ================================================================
set -euo pipefail

# ── config ────────────────────────────────────────────────────────
REPO_URL="https://github.com/atreasureboy/ovolv999_coding_pro.git"
REPO_BRANCH="main"
INSTALL_DIR="${OVOGO_INSTALL_DIR:-$HOME/.ovolv999}"
BIN_NAME="ovolv999"
MIN_NODE_MAJOR=20

# ── pretty printing ───────────────────────────────────────────────
if [ -t 1 ]; then
  C_GREEN=$'\033[0;32m'; C_YELLOW=$'\033[1;33m'; C_RED=$'\033[0;31m'
  C_CYAN=$'\033[0;36m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'; C_RESET=$'\033[0m'
else
  C_GREEN=""; C_YELLOW=""; C_RED=""; C_CYAN=""; C_DIM=""; C_BOLD=""; C_RESET=""
fi
info()  { printf "%s[info]%s %s\n" "$C_CYAN" "$C_RESET" "$*"; }
ok()    { printf "%s[ok]%s   %s\n" "$C_GREEN" "$C_RESET" "$*"; }
warn()  { printf "%s[warn]%s %s\n" "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()   { printf "%s[error]%s %s\n" "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

# ── arg parsing ───────────────────────────────────────────────────
ACTION="install"
while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) ACTION="uninstall"; shift ;;
    --update)    ACTION="install"; shift ;;   # install is already idempotent/update
    --version)   REPO_BRANCH="$2"; shift 2 ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,14p' "$0" 2>/dev/null || true
      exit 0 ;;
    *) die "Unknown option: $1 (try --help)" ;;
  esac
done

# ── uninstall ─────────────────────────────────────────────────────
if [ "$ACTION" = "uninstall" ]; then
  info "Removing ovolv999..."
  # Remove every symlink named $BIN_NAME on PATH that points at our install.
  IFS=':' read -r -a _path_dirs <<< "$PATH"
  for d in "${_path_dirs[@]}"; do
    [ -L "$d/$BIN_NAME" ] || continue
    case "$(readlink "$d/$BIN_NAME" 2>/dev/null || true)" in
      "$INSTALL_DIR"/*|*/ovogogogo.js)
        rm -f "$d/$BIN_NAME" && ok "removed symlink $d/$BIN_NAME" ;;
    esac
  done
  if [ -d "$INSTALL_DIR" ]; then
    rm -rf "$INSTALL_DIR" && ok "removed $INSTALL_DIR"
  fi
  printf "\n%sovolv999 uninstalled. (Run data in ~/.ovogo is left untouched.)%s\n" "$C_DIM" "$C_RESET"
  exit 0
fi

# ── install/update ────────────────────────────────────────────────
info "Installing ovolv999 ($REPO_BRANCH) into $C_BOLD$INSTALL_DIR$C_RESET"

# OS check
case "$(uname -s)" in
  Linux*|Darwin*) : ;;
  MINGW*|MSYS*|CYGWIN*) die "Windows detected — use PowerShell: irm https://raw.githubusercontent.com/atreasureboy/ovolv999_coding_pro/main/install.ps1 | iex" ;;
  *) die "Unsupported OS: $(uname -s)" ;;
esac

# Node >= MIN_NODE_MAJOR
if ! command -v node >/dev/null 2>&1; then
  die "Node.js not found. Install Node >= $MIN_NODE_MAJOR (https://nodejs.org or 'nvm install --lts')."
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
  die "Node $NODE_MAJOR found — ovolv999 needs Node >= $MIN_NODE_MAJOR. Upgrade: https://nodejs.org"
fi
ok "Node $(node -v)"

# git
command -v git >/dev/null 2>&1 || die "git not found. Install git first."

# Clone or update
if [ -d "$INSTALL_DIR/.git" ]; then
  info "Existing install found — updating..."
  git -C "$INSTALL_DIR" fetch --quiet origin "$REPO_BRANCH"
  git -C "$INSTALL_DIR" checkout --quiet "$REPO_BRANCH"
  git -C "$INSTALL_DIR" reset --quiet --hard "origin/$REPO_BRANCH"
else
  info "Cloning repository (shallow)..."
  mkdir -p "$INSTALL_DIR"
  git clone --quiet --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi
ok "source ready at $INSTALL_DIR"

# Install deps + build
info "Installing dependencies (this can take a minute)..."
( cd "$INSTALL_DIR" && npm install --no-audit --no-fund --loglevel=error ) \
  || die "npm install failed."
info "Building (tsc)..."
( cd "$INSTALL_DIR" && npm run build ) || die "build failed."
# tsc doesn't set the executable bit on the entry; the symlink is only
# directly runnable (`ovolv999 ...`, not `node .../ovogogogo.js`) if the
# target has +x (it has a #!/usr/bin/env node shebang).
chmod +x "$INSTALL_DIR/dist/bin/ovogogogo.js" 2>/dev/null || true
ok "built"

ENTRY="$INSTALL_DIR/dist/bin/ovogogogo.js"
[ -x "$ENTRY" ] || die "build output missing or not executable: $ENTRY"

# ── choose a PATH directory for the symlink (prefer writable, no sudo) ─
choose_bindir() {
  local candidate fallback=""
  # 1) first writable dir already on PATH
  local IFS=':'
  for d in $PATH; do
    [ -d "$d" ] && [ -w "$d" ] || continue
    case "$d" in
      /usr/local/bin|/opt/homebrew/bin|/usr/bin|/bin) echo "$d"; return 0 ;;
    esac
  done
  # 2) common writable locations
  for d in /usr/local/bin /opt/homebrew/bin "$HOME/.local/bin" "$HOME/bin"; do
    if [ -d "$d" ] && [ -w "$d" ]; then echo "$d"; return 0; fi
    [ -z "$fallback" ] && case "$d" in "$HOME"/*) fallback="$d" ;; esac
  done
  # 3) create ~/.local/bin
  fallback="${fallback:-$HOME/.local/bin}"
  mkdir -p "$fallback"
  echo "$fallback"
}

BIN_DIR="$(choose_bindir)"
mkdir -p "$BIN_DIR"

ln -sfn "$ENTRY" "$BIN_DIR/$BIN_NAME"
ok "linked $C_BOLD$BIN_NAME$C_RESET -> $ENTRY"

# If we used ~/.local/bin (or ~/bin) and it's not on PATH, add it to shell rc.
add_to_path_rc() {
  local dir="$1" rc=""
  case ":$PATH:" in *":$dir:"*) return 0 ;; esac
  [ -f "$HOME/.zshrc" ] && rc="$HOME/.zshrc"
  { [ -z "$rc" ] && [ -f "$HOME/.bashrc" ]; } && rc="$HOME/.bashrc"
  [ -z "$rc" ] && [ -f "$HOME/.profile" ] && rc="$HOME/.profile"
  if [ -n "$rc" ]; then
    if ! grep -qE "^[[:space:]]*export PATH=.*\b$dir\b" "$rc" 2>/dev/null; then
      printf '\n# Added by ovolv999 installer\nexport PATH="%s:$PATH"\n' "$dir" >> "$rc"
      warn "$dir was added to PATH in $(basename "$rc"). Restart your shell or run: export PATH=\"$dir:\$PATH\""
    fi
  fi
}
case "$BIN_DIR" in
  "$HOME"/*) add_to_path_rc "$BIN_DIR" ;;
esac

# ── verify ────────────────────────────────────────────────────────
hash -r 2>/dev/null || true
if command -v "$BIN_NAME" >/dev/null 2>&1; then
  ok "verification: '$BIN_NAME --version' resolves"
else
  warn "'$BIN_NAME' not on current PATH yet. Open a new shell, or run: export PATH=\"$BIN_DIR:\$PATH\""
fi

# ── detect Claude Code config (zero-config reuse) ─────────────────
CLAUDE_CFG="$HOME/.claude/settings.json"
if [ -f "$CLAUDE_CFG" ] && grep -q '"ANTHROPIC_BASE_URL"' "$CLAUDE_CFG" 2>/dev/null; then
  MODEL="$(grep -oE '"ANTHROPIC_MODEL"[[:space:]]*:[[:space:]]*"[^"]*"' "$CLAUDE_CFG" | head -1 | sed 's/.*: *"\([^"]*\)".*/\1/')"
  ok "Claude Code config detected — ovolv999 will reuse it ($C_BOLD${MODEL:-your configured model}$C_RESET), no API key setup needed."
fi

# ── done ──────────────────────────────────────────────────────────
cat <<EOF

${C_BOLD}${C_GREEN}  ovolv999 installed successfully.${C_RESET}

${C_BOLD}Quick start${C_RESET}
  ${C_DIM}# first-run provider wizard (detects Claude Code / OpenAI, ~10s)${C_RESET}
  ${C_BOLD}ovolv999${C_RESET} init

  ${C_DIM}# interactive REPL${C_RESET}
  ${C_BOLD}ovolv999${C_RESET}

  ${C_DIM}# single task${C_RESET}
  ${C_BOLD}ovolv999${C_RESET} "fix the failing tests in src/core"

${C_BOLD}Update${C_RESET}    re-run this installer, or:  ovolv999 --update  (coming soon)
${C_BOLD}Uninstall${C_RESET}  curl -fsSL https://raw.githubusercontent.com/atreasureboy/ovolv999_coding_pro/main/install.sh | bash -s -- --uninstall

${C_DIM}Config lives in ~/.ovogo/. Source in $INSTALL_DIR.${C_RESET}
EOF
