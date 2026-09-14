@REM SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
@REM SPDX-License-Identifier: BSD-3-Clause

cd /d %~dp0
cd ../

for /d /r app\backend %%d in (__pycache__) do @if exist "%%d" rd /s /q "%%d"
rd /s /q app\backend\.pytest_cache
rd /s /q app\backend\.venv
rd /s /q app\frontend\build
rd /s /q app\frontend\node_modules
rd /s /q app\frontend\.pnpm-store

pause
