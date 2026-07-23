#Requires -Version 5.1
# ================================================================
#  ovolv999 — one-line installer (Windows / PowerShell)
#
#  Install:   irm https://raw.githubusercontent.com/atreasureboy/ovolv999_coding_pro/main/install.ps1 | iex
#  Update:    irm https://raw.githubusercontent.com/atreasureboy/ovolv999_coding_pro/main/install.ps1 | iex
#  Uninstall: irm https://raw.githubusercontent.com/atreasureboy/ovolv999_coding_pro/main/install.ps1 | iex -Args "--uninstall"
#
#  Clones the repo to %USERPROFILE%\.ovolv999, installs deps, builds,
#  and drops an `ovolv999.cmd` shim on the user PATH. Re-running updates
#  in place. If Claude Code is configured (~/.claude/settings.json) the
#  provider is reused zero-config.
# ================================================================
[CmdletBinding()]
param(
  [string]$InstallDir = "",
  [string]$Branch = "main",
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$BinName = "ovolv999"
$RepoUrl = "https://github.com/atreasureboy/ovolv999_coding_pro.git"
if (-not $InstallDir) { $InstallDir = Join-Path $env:USERPROFILE ".ovolv999" }

function Write-Info($m) { Write-Host "[info] $m" -ForegroundColor Cyan }
function Write-OK($m)   { Write-Host "[ok]   $m" -ForegroundColor Green }
function Write-Warn($m) { Write-Host "[warn] $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "[error] $m" -ForegroundColor Red; exit 1 }

# ── uninstall ─────────────────────────────────────────────────────
if ($Uninstall) {
  Write-Info "Removing ovolv999..."
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  foreach ($dir in ($userPath -split ";")) {
    if (-not $dir) { continue }
    $shim = Join-Path $dir "$BinName.cmd"
    if (Test-Path $shim) {
      try { Remove-Item $shim -Force; Write-OK "removed $shim" } catch {}
    }
  }
  if (Test-Path $InstallDir) {
    Remove-Item $InstallDir -Recurse -Force; Write-OK "removed $InstallDir"
  }
  Write-Host "`novolv999 uninstalled. (Run data in ~/.ovogo is left untouched.)" -ForegroundColor DarkGray
  exit 0
}

# ── install/update ────────────────────────────────────────────────
Write-Info "Installing ovolv999 ($Branch) into $InstallDir"

# Node >= 20
try { $nodeVer = (node -v) -replace '^v','' } catch { Die "Node.js not found. Install Node >= 20 (https://nodejs.org)." }
$nodeMajor = ($nodeVer -split '\.')[0]
if ([int]$nodeMajor -lt 20) { Die "Node $nodeVer found — ovolv999 needs Node >= 20." }
Write-OK "Node $(node -v)"

try { git --version | Out-Null } catch { Die "git not found. Install git first." }

# Clone or update
if (Test-Path (Join-Path $InstallDir ".git")) {
  Write-Info "Existing install found - updating..."
  git -C $InstallDir fetch --quiet origin $Branch
  git -C $InstallDir checkout --quiet $Branch
  git -C $InstallDir reset --quiet --hard "origin/$Branch"
} else {
  Write-Info "Cloning repository (shallow)..."
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  git clone --quiet --depth 1 --branch $Branch $RepoUrl $InstallDir
}
Write-OK "source ready at $InstallDir"

# Install deps + build
Write-Info "Installing dependencies (this can take a minute)..."
Push-Location $InstallDir
try {
  npm install --no-audit --no-fund --loglevel=error
  Write-Info "Building (tsc)..."
  npm run build
} catch { Die "install/build failed." }
finally { Pop-Location }
Write-OK "built"

$Entry = Join-Path $InstallDir "dist\bin\ovogogogo.js"
if (-not (Test-Path $Entry)) { Die "build output missing: $Entry" }

# ── create a .cmd shim on the user PATH ───────────────────────────
$ShimDir = Join-Path $env:USERPROFILE "bin"
New-Item -ItemType Directory -Force -Path $ShimDir | Out-Null
$Shim = Join-Path $ShimDir "$BinName.cmd"
# Windows can't exec a .js via shebang, so wrap with a .cmd that calls node.
$shimContent = "@echo off`r`nnode `"$Entry`" %*"
Set-Content -Path $Shim -Value $shimContent -Encoding ASCII

# Ensure ShimDir is on the USER Path (idempotent)
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$ShimDir*") {
  $newPath = if ($userPath) { "$ShimDir;$userPath" } else { $ShimDir }
  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  Write-Warn "Added $ShimDir to your USER Path. Open a NEW terminal for `ovolv999` to be found."
}
Write-OK "shim $BinName -> $Entry"

# ── detect Claude Code config ─────────────────────────────────────
$ClaudeCfg = Join-Path $env:USERPROFILE ".claude\settings.json"
if (Test-Path $ClaudeCfg) {
  try {
    $cfg = Get-Content $ClaudeCfg -Raw | ConvertFrom-Json
    if ($cfg.env.ANTHROPIC_BASE_URL) {
      $model = $cfg.env.ANTHROPIC_MODEL
      Write-OK "Claude Code config detected - ovolv999 will reuse it ($model), no API key setup needed."
    }
  } catch {}
}

# ── done ──────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ovolv999 installed successfully." -ForegroundColor Green
Write-Host ""
Write-Host "Quick start (open a NEW terminal first)" -ForegroundColor White
Write-Host "  ovolv999                          # interactive REPL"
Write-Host "  ovolv999 `"fix the failing tests`"   # single task"
Write-Host ""
Write-Host "Update     re-run this installer"  -ForegroundColor DarkGray
Write-Host "Uninstall  irm ... install.ps1 | iex -Args `"--uninstall`"" -ForegroundColor DarkGray
Write-Host "Config lives in ~/.ovogo/. Source in $InstallDir." -ForegroundColor DarkGray
