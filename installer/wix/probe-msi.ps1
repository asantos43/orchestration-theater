# SPDX-License-Identifier: MPL-2.0
#requires -Version 5.1
<#
.SYNOPSIS
  A probe of the .msi (N322): installs with the given properties, removes, and prints how long each
  took. Meant for the runner of .github/workflows/dist-msi.yml only (CI=true), like test-install.ps1;
  it checks nothing but the exit codes, so the full test stays the judge. [proposta] Temporary: it
  exists to find which part of the install hung a runner on 2026-11-25.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $Msi,
  [string[]] $Properties = @(),
  [ValidateRange(1, 60)] [int] $TimeoutMinutes = 2
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:CI -ne 'true') { throw 'This installs a real package: run it on a CI runner (CI=true).' }

$Msi = (Resolve-Path $Msi).Path
$LogDir = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }

function Invoke-Probe([string[]] $Arguments, [string] $LogName) {
  $log = Join-Path $LogDir $LogName
  # /norestart: a package that asks a reboot returns 3010 here instead of restarting the runner.
  $all = $Arguments + @('/qn', '/norestart', '/l*v', "`"$log`"")
  Write-Host "msiexec $($all -join ' ')"
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList $all -PassThru
  $null = $process.Handle
  $ended = $process.WaitForExit($TimeoutMinutes * 60 * 1000)
  Write-Host "took $([int]$watch.Elapsed.TotalSeconds) s"
  if (-not $ended) {
    Write-Host "::error::msiexec $($Arguments[0]) did not end in $TimeoutMinutes minute(s); the processes and the end of the log:"
    Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 15 Id, ProcessName, CPU, WorkingSet64 | Format-Table | Out-String | Write-Host
    if (Test-Path $log) { Get-Content $log -Tail 120 | ForEach-Object { Write-Host $_ } }
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    return -1
  }
  if ($process.ExitCode -ne 0 -and (Test-Path $log)) { Get-Content $log -Tail 80 | ForEach-Object { Write-Host $_ } }
  Write-Host "exit code $($process.ExitCode)"
  return $process.ExitCode
}

$install = Invoke-Probe (@('/i', "`"$Msi`"") + $Properties) 'probe-install.log'
$data = Join-Path $env:LOCALAPPDATA 'OTheater\config.yaml'
if (Test-Path $data) { Write-Host "config.yaml after the install:"; Get-Content -Raw $data | Write-Host }
$remove = Invoke-Probe @('/x', "`"$Msi`"") 'probe-remove.log'
# The full test that follows wants a clean machine: its data folder starts empty.
Remove-Item -Recurse -Force (Join-Path $env:LOCALAPPDATA 'OTheater') -ErrorAction SilentlyContinue
if ($install -ne 0 -or $remove -ne 0) { exit 1 }
exit 0
