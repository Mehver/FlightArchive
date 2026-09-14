@REM SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
@REM SPDX-License-Identifier: BSD-3-Clause

cd /d "%~dp0.."

for /d /r app\backend %%d in (__pycache__) do @if exist "%%d" rd /s /q "%%d"
rd /s /q app\backend\.pytest_cache
rd /s /q app\backend\.venv
rd /s /q app\frontend\build
rd /s /q app\frontend\node_modules
rd /s /q app\frontend\.pnpm-store

docker build --progress=plain --tag flightarchive:local -f "app\Dockerfile" "app"

if not defined RFG_RESOURCE_HOST_PATH set /p "RFG_RESOURCE_HOST_PATH=Existing RFG resource directory: "
if not defined RFG_DATA_HOST_PATH set /p "RFG_DATA_HOST_PATH=Writable RFG data directory: "
if not defined FLIGHTARCHIVE_CACHE_HOST_PATH set /p "FLIGHTARCHIVE_CACHE_HOST_PATH=Optional thumbnail cache directory (blank for container-only cache): "
if not defined FLIGHTARCHIVE_HOST_PORT set /p "FLIGHTARCHIVE_HOST_PORT=Host port [8080]: "
if not defined FLIGHTARCHIVE_CONTAINER_NAME set /p "FLIGHTARCHIVE_CONTAINER_NAME=FlightArchive container name [flightarchive]: "
if not defined FLIGHTARCHIVE_HOST_PORT set "FLIGHTARCHIVE_HOST_PORT=8080"
if not defined FLIGHTARCHIVE_CONTAINER_NAME set "FLIGHTARCHIVE_CONTAINER_NAME=flightarchive"
if not exist "%RFG_DATA_HOST_PATH%" mkdir "%RFG_DATA_HOST_PATH%"

if defined FLIGHTARCHIVE_CACHE_HOST_PATH (
  if not exist "%FLIGHTARCHIVE_CACHE_HOST_PATH%" mkdir "%FLIGHTARCHIVE_CACHE_HOST_PATH%"
  docker run --detach --name "%FLIGHTARCHIVE_CONTAINER_NAME%" --restart unless-stopped --publish "%FLIGHTARCHIVE_HOST_PORT%:8080" --volume "%RFG_RESOURCE_HOST_PATH%:/resource:ro" --volume "%RFG_DATA_HOST_PATH%:/data" --volume "%FLIGHTARCHIVE_CACHE_HOST_PATH%:/cache" flightarchive:local
) else (
  docker run --detach --name "%FLIGHTARCHIVE_CONTAINER_NAME%" --restart unless-stopped --publish "%FLIGHTARCHIVE_HOST_PORT%:8080" --volume "%RFG_RESOURCE_HOST_PATH%:/resource:ro" --volume "%RFG_DATA_HOST_PATH%:/data" flightarchive:local
)

pause
