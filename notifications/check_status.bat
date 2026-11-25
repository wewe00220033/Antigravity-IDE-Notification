@echo off
chcp 65001 >nul
title Antigravity IDE Notification Status
call "%~dp0_run.bat" --status
pause
