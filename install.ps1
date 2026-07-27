#Requires -Version 5.1
# ================================================================
#  ovolv999 — one-line installer (Windows / PowerShell)
#
#  Install:   irm https://raw.githubusercontent.com/atreasureboy/ovolv999_coding_pro/main/install.ps1 | iex
#  Update:    irm https://raw.githubusercontent.com/atreasureboy/ovolv999_coding_pro/main/install.ps1 | iex
#  Uninstall: & ([scriptblock]::Create((irm https://raw.githubusercontent.com/atreasureboy/ovolv999_coding_pro/main/install.ps1))) -Uninstall
#
#  Clones the repo to %USERPROFILE%\.ovolv999, installs deps, builds,
#  and drops an `ovolv999.cmd` shim on the user PATH. Re-running performs
#  a staged replacement. If Claude Code is configured (~/.claude/settings.json) the
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
$RepoUrl = if ($env:OVOGO_REPO_URL) { $env:OVOGO_REPO_URL } else { "https://github.com/atreasureboy/ovolv999_coding_pro.git" }
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
      try {
        $shimContent = Get-Content $shim -Raw
        if ($shimContent -like "*$InstallDir*") {
          Remove-Item $shim -Force
          Write-OK "removed $shim"
        }
      } catch {}
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

$InstallParent = Split-Path -Parent $InstallDir
New-Item -ItemType Directory -Force -Path $InstallParent | Out-Null
$StagingDir = "$InstallDir.staging.$([guid]::NewGuid().ToString('N'))"
$BackupDir = "$InstallDir.rollback"

Write-Info "Downloading source into a staging directory..."
git clone --quiet --depth 1 --branch $Branch $RepoUrl $StagingDir
if ($LASTEXITCODE -ne 0) { Die "git clone failed for branch or tag '$Branch'." }
if (-not (Test-Path (Join-Path $StagingDir "package-lock.json"))) {
  Remove-Item $StagingDir -Recurse -Force -ErrorAction SilentlyContinue
  Die "release is missing package-lock.json"
}

Write-Info "Installing locked dependencies..."
$InstallError = $null
Push-Location $StagingDir
try {
  npm ci --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { throw "npm dependency installation failed." }
  Write-Info "Building (tsc)..."
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "build failed." }
} catch {
  $InstallError = $_.Exception.Message
}
finally { Pop-Location }
if ($InstallError) {
  Remove-Item $StagingDir -Recurse -Force -ErrorAction SilentlyContinue
  Die "install/build failed: $InstallError"
}

$StagedEntry = Join-Path $StagingDir "dist\bin\ovogogogo.js"
if (-not (Test-Path $StagedEntry)) {
  Remove-Item $StagingDir -Recurse -Force -ErrorAction SilentlyContinue
  Die "build output missing: $StagedEntry"
}
& node $StagedEntry --version | Out-Null
if ($LASTEXITCODE -ne 0) {
  Remove-Item $StagingDir -Recurse -Force -ErrorAction SilentlyContinue
  Die "built CLI failed its version smoke test."
}

if (Test-Path $BackupDir) { Remove-Item $BackupDir -Recurse -Force }
if (Test-Path $InstallDir) {
  if (-not (Test-Path (Join-Path $InstallDir ".git"))) {
    Remove-Item $StagingDir -Recurse -Force -ErrorAction SilentlyContinue
    Die "install directory exists and is not an ovolv999 checkout: $InstallDir"
  }
  Move-Item $InstallDir $BackupDir
}
try {
  Move-Item $StagingDir $InstallDir
  if (Test-Path $BackupDir) { Remove-Item $BackupDir -Recurse -Force }
} catch {
  if (Test-Path $BackupDir) { Move-Item $BackupDir $InstallDir }
  Die "activation failed; the previous installation was restored."
}
Write-OK "release activated at $InstallDir"

$Entry = Join-Path $InstallDir "dist\bin\ovogogogo.js"

# ── create a .cmd shim on the user PATH ───────────────────────────
$ShimDir = Join-Path $env:USERPROFILE "bin"
New-Item -ItemType Directory -Force -Path $ShimDir | Out-Null
$Shim = Join-Path $ShimDir "$BinName.cmd"
# Windows can't exec a .js via shebang, so wrap with a .cmd that calls node.
$shimContent = "@echo off`r`nnode `"$Entry`" %*"
Set-Content -Path $Shim -Value $shimContent -Encoding ASCII

# Ensure ShimDir is on the USER Path (idempotent)
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$pathEntries = @($userPath -split ";" | Where-Object { $_ } | ForEach-Object { $_.TrimEnd("\") })
if ($pathEntries -notcontains $ShimDir.TrimEnd("\")) {
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
Write-Host "Uninstall  download install.ps1 and run: .\install.ps1 -Uninstall" -ForegroundColor DarkGray
Write-Host "Config lives in ~/.ovogo/. Source in $InstallDir." -ForegroundColor DarkGray
