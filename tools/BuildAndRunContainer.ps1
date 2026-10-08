# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

function Remove-DirectoryIfExists {
    param([string]$Path)

    if (Test-Path -LiteralPath $Path -PathType Container) {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
}

$repositoryPath = [System.IO.Path]::GetFullPath((Join-Path -Path $PSScriptRoot -ChildPath '..'))
$appPath = Join-Path -Path $repositoryPath -ChildPath 'app'
$backendPath = Join-Path -Path $appPath -ChildPath 'backend'
$frontendPath = Join-Path -Path $appPath -ChildPath 'frontend'
$dockerfilePath = Join-Path -Path $appPath -ChildPath 'Dockerfile'

if (Test-Path -LiteralPath $backendPath -PathType Container) {
    $pythonCachePaths = @(Get-ChildItem -LiteralPath $backendPath -Directory -Recurse -Force |
        Where-Object { $_.Name -eq '__pycache__' } |
        ForEach-Object { $_.FullName })
    foreach ($pythonCachePath in $pythonCachePaths) {
        Remove-DirectoryIfExists -Path $pythonCachePath
    }
}

Remove-DirectoryIfExists -Path (Join-Path -Path $backendPath -ChildPath '.pytest_cache')
Remove-DirectoryIfExists -Path (Join-Path -Path $backendPath -ChildPath '.venv')
Remove-DirectoryIfExists -Path (Join-Path -Path $frontendPath -ChildPath 'build')
Remove-DirectoryIfExists -Path (Join-Path -Path $frontendPath -ChildPath 'node_modules')
Remove-DirectoryIfExists -Path (Join-Path -Path $frontendPath -ChildPath '.pnpm-store')

$dockerBuildArguments = @(
    'build'
    '--progress=plain'
    '--tag'
    'flightarchive:local'
    '-f'
    $dockerfilePath
    $appPath
)
& docker @dockerBuildArguments

if ([string]::IsNullOrEmpty($env:RFG_RESOURCE_HOST_PATH)) {
    $env:RFG_RESOURCE_HOST_PATH = Read-Host 'Existing RFG resource directory'
}
if ([string]::IsNullOrEmpty($env:RFG_DATA_HOST_PATH)) {
    $env:RFG_DATA_HOST_PATH = Read-Host 'Writable RFG data directory'
}
if ([string]::IsNullOrEmpty($env:FLIGHTARCHIVE_CACHE_HOST_PATH)) {
    $env:FLIGHTARCHIVE_CACHE_HOST_PATH = Read-Host 'Optional thumbnail cache directory (blank for container-only cache)'
}
if ([string]::IsNullOrEmpty($env:FLIGHTARCHIVE_HOST_PORT)) {
    $env:FLIGHTARCHIVE_HOST_PORT = Read-Host 'Host port [8080]'
}
if ([string]::IsNullOrEmpty($env:FLIGHTARCHIVE_CONTAINER_NAME)) {
    $env:FLIGHTARCHIVE_CONTAINER_NAME = Read-Host 'FlightArchive container name [flightarchive]'
}
if ([string]::IsNullOrEmpty($env:FLIGHTARCHIVE_HOST_PORT)) {
    $env:FLIGHTARCHIVE_HOST_PORT = '8080'
}
if ([string]::IsNullOrEmpty($env:FLIGHTARCHIVE_CONTAINER_NAME)) {
    $env:FLIGHTARCHIVE_CONTAINER_NAME = 'flightarchive'
}

if (-not (Test-Path -LiteralPath $env:RFG_DATA_HOST_PATH -PathType Container)) {
    [System.IO.Directory]::CreateDirectory($env:RFG_DATA_HOST_PATH) | Out-Null
}

$dockerRunArguments = @(
    'run'
    '--detach'
    '--name'
    $env:FLIGHTARCHIVE_CONTAINER_NAME
    '--restart'
    'unless-stopped'
    '--publish'
    "${env:FLIGHTARCHIVE_HOST_PORT}:8080"
    '--volume'
    "${env:RFG_RESOURCE_HOST_PATH}:/resource:ro"
    '--volume'
    "${env:RFG_DATA_HOST_PATH}:/data"
)

if (-not [string]::IsNullOrEmpty($env:FLIGHTARCHIVE_CACHE_HOST_PATH)) {
    if (-not (Test-Path -LiteralPath $env:FLIGHTARCHIVE_CACHE_HOST_PATH -PathType Container)) {
        [System.IO.Directory]::CreateDirectory($env:FLIGHTARCHIVE_CACHE_HOST_PATH) | Out-Null
    }
    $dockerRunArguments += @('--volume', "${env:FLIGHTARCHIVE_CACHE_HOST_PATH}:/cache")
}

$dockerRunArguments += 'flightarchive:local'
& docker @dockerRunArguments

Read-Host 'Press Enter to continue'
