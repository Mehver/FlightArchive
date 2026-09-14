@REM SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
@REM SPDX-License-Identifier: BSD-3-Clause

cd /d "%~dp0.."

docker build --progress=plain --tag flightarchive:local -f "app\Dockerfile" "app"
pause
