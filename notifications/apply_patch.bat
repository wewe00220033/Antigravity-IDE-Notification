@echo off
chcp 65001 >nul
title Antigravity IDE Notification Patcher (Apply)
call "%~dp0_run.bat" --apply --test
echo.
echo ============================================================
echo   Next step inside Antigravity IDE:
echo   Press Ctrl+Shift+P -^> Developer: Reload Window
echo ============================================================
pause
