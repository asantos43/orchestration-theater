# SPDX-License-Identifier: MPL-2.0
#requires -Version 5.1
<#
.SYNOPSIS
  The acceptance of the .msi (Phase 10, P4): installs, checks, uninstalls, checks again.

.DESCRIPTION
  Meant for a disposable Windows machine (the runner of .github/workflows/dist-msi.yml). It really
  installs the package for the current user, creates the real Scheduled Task `otheater-daemon` and
  removes both at the end; it refuses to run without CI=true (or -Force), and never on a machine where
  OTheater is already installed. The data folder (%LOCALAPPDATA%\OTheater) is given a marker file
  before the uninstall and has to keep it.

.PARAMETER Msi
  The package to test.
.PARAMETER SemVer
  The version `ot --version` has to print.
.PARAMETER Force
  Runs outside CI (a Windows virtual machine of yours).
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $Msi,
  [Parameter(Mandatory = $true)] [string] $SemVer,
  [switch] $Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:CI -ne 'true' -and -not $Force) {
  throw 'This installs a real package and a real Scheduled Task: run it on a CI runner (CI=true) or pass -Force on a disposable machine.'
}

$TaskName = 'otheater-daemon'
$InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\OTheater'
$DataDir = Join-Path $env:LOCALAPPDATA 'OTheater'
$Msi = (Resolve-Path $Msi).Path
$LogDir = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$failures = New-Object System.Collections.Generic.List[string]

function Step([string] $Name) { Write-Host "`n=== $Name" }
function Check([bool] $Condition, [string] $Message) {
  if ($Condition) { Write-Host "ok   $Message" }
  else { Write-Host "FAIL $Message"; $script:failures.Add($Message) }
}

function Invoke-Msi([string[]] $Arguments, [string] $LogName) {
  $log = Join-Path $LogDir $LogName
  $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList ($Arguments + @('/qn', '/l*v', "`"$log`"")) -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    Write-Host "msiexec exited with $($process.ExitCode); the end of the log:"
    if (Test-Path $log) { Get-Content $log -Tail 80 | ForEach-Object { Write-Host $_ } }
  }
  return $process.ExitCode
}

function Test-TaskExists {
  & schtasks.exe /Query /TN $TaskName *> $null
  return ($LASTEXITCODE -eq 0)
}

function Get-UserPathEntries {
  $path = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ([string]::IsNullOrEmpty($path)) { return @() }
  return @($path -split ';' | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\') })
}

Step 'Before: a clean machine'
Check (-not (Test-Path $InstallDir)) "no $InstallDir yet"
Check (-not (Test-TaskExists)) "no task $TaskName yet"
if ($failures.Count -gt 0) { throw 'The machine is not clean: not installing over it.' }
$pathBefore = (Get-UserPathEntries) -join ';'

Step 'Install: msiexec /i /qn'
$code = Invoke-Msi @('/i', "`"$Msi`"") 'msi-install.log'
Check ($code -eq 0) "msiexec /i exited with 0 (got $code)"
foreach ($file in 'ot.exe', 'ot-job-launcher.exe', 'LICENSE', 'THIRD_PARTY_NOTICES.md') {
  Check (Test-Path (Join-Path $InstallDir $file) -PathType Leaf) "installed $file"
}
Check ((Get-UserPathEntries) -contains $InstallDir) 'the install folder is in the PATH of the user'
Check (Test-TaskExists) "the Scheduled Task $TaskName exists"
if (Test-TaskExists) {
  $action = (Get-ScheduledTask -TaskName $TaskName).Actions[0]
  $line = "$($action.Execute) $($action.Arguments)"
  Write-Host "task action: $line"
  Check ($line -like '*OTheater\ot.exe*daemon*') 'the task runs the installed ot.exe with the daemon command'
}

Step 'ot --version, by name from the PATH of the user'
# The session of this script has the PATH of before the install: take the one the registry has now.
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
$resolved = Get-Command ot -ErrorAction SilentlyContinue
Check ($null -ne $resolved -and $resolved.Source -eq (Join-Path $InstallDir 'ot.exe')) 'ot resolves to the installed ot.exe'
$versionOutput = (& (Join-Path $InstallDir 'ot.exe') --version | Out-String).Trim()
Write-Host "ot --version: $versionOutput"
Check ($versionOutput -eq $SemVer -or $versionOutput.Contains($SemVer)) "ot --version prints $SemVer"

Step 'The service status, and the data folder'
$statusJson = & (Join-Path $InstallDir 'ot.exe') service status --json | Out-String
Write-Host $statusJson.Trim()
Check ($statusJson -match '"installed":\s*true') 'ot service status says the service is installed'
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
Set-Content -Path (Join-Path $DataDir 'marker.txt') -Value 'kept'

Step 'Start the daemon through the task (it has to be stopped by the uninstall)'
# The same config as the smoke test of the executable: the file vault, no keyring prompt, no backup.
@"
ui:
  locale: en
adapters:
  vault: encrypted-file
vault:
  scrypt: { N: 16384, r: 8, p: 1 }
backup:
  when: manual
  content: store_only
"@ | Set-Content -Path (Join-Path $DataDir 'config.yaml') -Encoding utf8
& (Join-Path $InstallDir 'ot.exe') service start
$running = $false
for ($i = 0; $i -lt 60 -and -not $running; $i++) {
  Start-Sleep -Seconds 1
  $running = (& (Join-Path $InstallDir 'ot.exe') service status --json | Out-String) -match '"running":\s*true'
}
# [N] A runner may have no session for the user, and the task then does not start: a warning, not a
# failure (the install and the removal of the task are what this test is for).
if ($running) { Write-Host 'ok   the daemon is running' }
else { Write-Host '::warning::the daemon did not start from the task on this runner; the stop in the uninstall is not exercised' }

Step 'Uninstall: msiexec /x /qn'
$code = Invoke-Msi @('/x', "`"$Msi`"") 'msi-uninstall.log'
Check ($code -eq 0) "msiexec /x exited with 0 (got $code)"
Check (-not (Test-Path (Join-Path $InstallDir 'ot.exe'))) 'ot.exe is gone'
Check (-not (Test-Path (Join-Path $InstallDir 'ot-job-launcher.exe'))) 'ot-job-launcher.exe is gone'
Check (-not (Test-Path $InstallDir)) 'the install folder is gone'
Check (-not (Test-TaskExists)) "the Scheduled Task $TaskName is gone"
Check (-not ((Get-UserPathEntries) -contains $InstallDir)) 'the install folder left the PATH of the user'
Check (((Get-UserPathEntries) -join ';') -eq $pathBefore) 'the PATH of the user is what it was before'
Check (Test-Path (Join-Path $DataDir 'marker.txt')) 'the data folder kept its files'

# Do not leave anything on the runner when a check failed in the middle.
if ($failures.Count -gt 0) {
  if (Test-Path (Join-Path $InstallDir 'ot.exe')) { Invoke-Msi @('/x', "`"$Msi`"") 'msi-cleanup.log' | Out-Null }
  Write-Host "`n$($failures.Count) check(s) failed:"
  $failures | ForEach-Object { Write-Host " - $_" }
  exit 1
}
Write-Host "`nAll checks passed."
# The step takes its result from $LASTEXITCODE, which still holds the last native command (a
# `schtasks /query` of the task that is gone returns 1): end with the result of the checks.
exit 0
