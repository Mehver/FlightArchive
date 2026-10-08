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

Read-Host 'Press Enter to continue'
