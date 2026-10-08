# SPDX-FileCopyrightText: 2026 Mehver (https://github.com/Mehver)
# SPDX-License-Identifier: BSD-3-Clause

$repositoryPath = [System.IO.Path]::GetFullPath((Join-Path -Path $PSScriptRoot -ChildPath '..'))
$appPath = Join-Path -Path $repositoryPath -ChildPath 'app'
$dockerfilePath = Join-Path -Path $appPath -ChildPath 'Dockerfile'

$dockerArguments = @(
    'build'
    '--progress=plain'
    '--tag'
    'flightarchive:local'
    '-f'
    $dockerfilePath
    $appPath
)
& docker @dockerArguments

Read-Host 'Press Enter to continue'
