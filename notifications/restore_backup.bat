@echo off
chcp 65001 >nul
title Antigravity IDE Notification Restore
call "%~dp0_run.bat" --restore
pause
