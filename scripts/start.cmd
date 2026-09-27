@echo off
rem ===========================================================================
rem dsh-go-gateway-fix -- Windows launcher with crash auto-restart.
rem
rem Double-click to run. If the proxy process dies, it is restarted after 3s.
rem
rem NOTE: this file is intentionally ASCII-only and MUST keep CRLF endings.
rem       cmd.exe mis-parses UTF-8 batch files, and putting `chcp 65001` inside
rem       a batch file desyncs the parser (later lines get truncated), so a
rem       Chinese .cmd would garble or break outright. Chinese docs live in
rem       README.md; this launcher stays English so it works on every codepage.
rem
rem To change the port or enable fragment merging, create proxy.env.cmd next to
rem this file containing e.g.:
rem     set PORT=8899
rem     set DSH_MERGE_FRAGMENT=1
rem
rem Stop      : close this window, or end node.exe in Task Manager.
rem Autostart : powershell -ExecutionPolicy Bypass -File install-autostart.ps1
rem ===========================================================================

setlocal
set "SCRIPT_DIR=%~dp0"
set "ROOT=%SCRIPT_DIR%.."

rem Optional per-install env file (skipped when absent)
if exist "%SCRIPT_DIR%proxy.env.cmd" call "%SCRIPT_DIR%proxy.env.cmd"

if not defined PORT set "PORT=8899"

echo [dsh-go-gateway-fix] proxy dir  : %ROOT%
echo [dsh-go-gateway-fix] listening  : 127.0.0.1:%PORT%
if defined DSH_MERGE_FRAGMENT echo [dsh-go-gateway-fix] merge frag : ON (%DSH_MERGE_FRAGMENT%)
echo [dsh-go-gateway-fix] Ctrl+C or close this window to stop
echo.

:loop
node "%ROOT%\proxy.js"
set "CODE=%ERRORLEVEL%"
echo.
echo [dsh-go-gateway-fix] proxy exited (exit=%CODE%), restarting in 3s ...
rem Use `ping` as the sleep: `timeout` needs an interactive stdin and aborts
rem with "Input redirection is not supported" whenever output is redirected.
ping -n 4 127.0.0.1 >nul 2>&1
goto loop