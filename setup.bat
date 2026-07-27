@echo off
chcp 65001 >nul 2>nul
REM ================================================================
REM  ovolv999 一键安装 (Windows)
REM
REM  用法: 双击运行 或 在终端执行 setup.bat
REM  安装后: 终端输入 ovolv999 即可启动
REM ================================================================

echo.
echo  =======================================
echo    ovolv999 Agent Base — Setup (Windows)
echo  =======================================
echo.

REM ── 1. 检查 Node.js ──
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo  [X] Node.js not found
    echo      Install from https://nodejs.org (LTS recommended)
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node -v') do set NODE_VER=%%i
echo  [OK] Node.js: %NODE_VER%

REM ── 2. 切到项目目录 ──
set "PROJECT_DIR=%~dp0"
set "PROJECT_DIR=%PROJECT_DIR:~0,-1%"
cd /d "%PROJECT_DIR%"

for /f "tokens=*" %%i in ('node -p "process.versions.node.split('.')[0]"') do set NODE_MAJOR=%%i
if %NODE_MAJOR% LSS 20 (
    echo  [X] Node 20 or newer is required
    pause
    exit /b 1
)

REM ── 4. 安装依赖 ──
echo.
echo  [1/3] Installing dependencies...
if not exist "package-lock.json" (
    echo  [X] package-lock.json is required for reproducible setup
    pause
    exit /b 1
)
call npm ci --no-audit --no-fund
if %errorlevel% neq 0 (
    echo  [X] Install failed
    pause
    exit /b 1
)
echo  [OK] Dependencies ready

REM ── 5. 编译 ──
echo.
echo  [2/3] Building TypeScript...
call npm run build
if %errorlevel% neq 0 (
    echo  [X] Build failed
    pause
    exit /b 1
)
echo  [OK] Build complete

REM ── 7. 全局命令 ──
echo.
echo  [3/3] Creating global command "ovolv999"...
call npm link 2>nul
if %errorlevel% neq 0 (
    echo  [!] npm link failed
    echo      Run directly with: node "%PROJECT_DIR%\dist\bin\ovogogogo.js"
) else (
    echo  [OK] Global command "ovolv999" linked
)

REM ── 8. 验证 ──
echo.
echo  =======================================
echo    Verification
echo  =======================================
echo.
node "%PROJECT_DIR%\dist\bin\ovogogogo.js" --version >nul 2>nul
if %errorlevel% neq 0 (
    echo  [X] Built CLI failed verification
    pause
    exit /b 1
) else (
    ovolv999 --version >nul 2>nul
)
if %errorlevel% neq 0 (
    echo  [!] Global command not in PATH yet
    echo      Restart your terminal, or run: node "%PROJECT_DIR%\dist\bin\ovogogogo.js"
) else (
    echo  [OK] ovolv999 is ready!
)

echo.
echo  =======================================
echo    Done!
echo  =======================================
echo.
echo  Usage:
echo    ovolv999                         Interactive REPL
echo    ovolv999 "fix type errors"        Single task
echo    ovolv999 --help                   Show help
echo.
echo  Config (.env or environment vars):
echo    OPENAI_API_KEY=sk-...             OpenAI-compatible providers
echo    ANTHROPIC_AUTH_TOKEN=...           Anthropic-compatible providers
echo    OPENAI_BASE_URL=https://...       Optional (proxy)
echo    OVOGO_MODEL=claude-sonnet-4-6     Optional (model name)
echo.
pause
