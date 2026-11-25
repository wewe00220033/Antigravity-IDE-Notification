@echo off
chcp 65001 >nul
title Antigravity IDE Notification Test
call "%~dp0_run.bat" --test
pause
