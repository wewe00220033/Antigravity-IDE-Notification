@echo off
chcp 65001 >nul
set "PY_EXE="
set "PY_ARGS="
where python >nul 2>&1 && set "PY_EXE=python"
if "%PY_EXE%"=="" (
    where py >nul 2>&1 && (
        set "PY_EXE=py"
        set "PY_ARGS=-3"
    )
)
if "%PY_EXE%"=="" (
    for %%P in (
        "%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
        "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
        "%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
        "C:\Python315\python.exe"
        "C:\Python312\python.exe"
    ) do (
        if exist %%P if "%PY_EXE%"=="" set "PY_EXE=%%~P"
    )
)
if "%PY_EXE%"=="" (
    echo [ERROR] Python 3 was not found in PATH or standard locations.
    exit /b 1
)
"%PY_EXE%" %PY_ARGS% "%~dp0patch_notifications.py" %*
exit /b %ERRORLEVEL%
