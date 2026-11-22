# SPDX-License-Identifier: MPL-2.0
#requires -Version 5.1
<#
.SYNOPSIS
  Builds the .msi of OTheater for Windows (Phase 10, P4) with the WiX Toolset.

.DESCRIPTION
  Runs `wix build` over installer/wix/Product.wxs, with the single executable of P1 (dist/sea), the
  launcher of P2 (native/job-launcher) and the notices. It publishes nothing and signs nothing
  (N247): the .msi is a file in dist/msi.

  THE WIX THIS SCRIPT USES (N249, N250)
  - Version: 6.0.2 of the `wix` .NET tool, published on NuGet on 2025-08-28 (the latest of series 6;
    7.0.x exists, and the owner approved series 6 only). Pinned below ($WixVersion) and in
    .github/workflows/dist-msi.yml; tools/release/src/msi-sources.test.ts checks that the two agree.
  - Installed only on the Windows runner of the CI, by `dotnet tool install --global wix --version
    6.0.2`. This script does not install it unless it is given -InstallWix. Nothing of WiX is
    downloaded on a Linux or macOS machine, and the script does not run there.
  - License [S: nuspec of wix 6.0.2 on NuGet, LICENSE.TXT of github.com/wixtoolset/wix and the
    FireGiant docs "Open Source Maintenance Fee", all read on 2026-11-22]: the source code of WiX is
    MS-RL. The package of series 6 declares the Open Source Maintenance Fee EULA (OSMFEULA.txt,
    requireLicenseAcceptance=true); series 5 and earlier were MS-RL on NuGet. The fee started with
    series 6: whoever uses the Binary Release in revenue-generating activities and has an annual
    gross revenue of US$10,000 or more has to sponsor the wixtoolset organization on GitHub (the
    EULA text says "at least", the docs say "more than"). Below that, or building WiX from its
    source, the fee does not apply. The FireGiant page says that the enforcement of the EULA
    acceptance came only with WiX 7 (the EULA id of series 6 is "N/A"): series 6 asks for no
    acceptance command (`wix eula accept`, `-acceptEula`) and none is written in this repository.
    Using the Binary Release still means agreeing to that EULA, so whether the fee applies is a
    decision of the owner (see the report of P4). WiX is a build tool (level D): the .msi does not
    carry it; with no extension, WiX embeds nothing in it besides the standard Windows Installer
    tables.

  THE VERSION
  The version comes from tools/release/release.config.json (`versionOverride`, the one P1 embeds
  in the executable) and, when it is null, from packages/daemon/package.json, as P1 does. An MSI
  ProductVersion is major.minor.build only (major and minor up to 255, build up to 65535): the
  pre-release tag of a semver is dropped for it, and Windows Installer cannot tell two pre-releases
  of the same numbers apart. The complete semver goes to the file name and to the registry.

.PARAMETER Exe
  The single executable (Node SEA) of the win32-x64 target. Default: dist/sea/win32-x64/otheater.exe.
  It is installed as ot.exe. [proposta]
.PARAMETER Launcher
  ot-job-launcher.exe. Default: native/job-launcher/target/release/ot-job-launcher.exe.
.PARAMETER NoticesFile
  The third-party notices of the package (installed as THIRD_PARTY_NOTICES.md). Default: the
  THIRD_PARTY_NOTICES.md of the repository; P10 changes it to THIRD_PARTY_NOTICES-win32-x64.md.
.PARAMETER LauncherNoticesFile
  The notices of the launcher. Default: native/job-launcher/THIRD_PARTY_NOTICES.md. An empty string
  leaves it out (for when the notices of the platform already cover the launcher).
.PARAMETER LicenseFile
  The license of the product. Default: LICENSE.
.PARAMETER ConfigFile
  Default: tools/release/release.config.json.
.PARAMETER Version
  A semver that replaces the one of the config and of the package (for a test).
.PARAMETER OutDir
  Default: dist/msi. The file is OTheater-<semver>-win32-x64.msi.
.PARAMETER InstallWix
  Installs the pinned WiX with `dotnet tool install --global` when `wix` is not there.
.PARAMETER PrintVersionOnly
  Prints the derived versions as JSON and exits, without WiX. For checking the derivation.
#>
[CmdletBinding()]
param(
  [string] $Exe,
  [string] $Launcher,
  [string] $NoticesFile,
  [string] $LauncherNoticesFile,
  [string] $LicenseFile,
  [string] $ConfigFile,
  [string] $Version,
  [string] $OutDir,
  [switch] $InstallWix,
  [switch] $PrintVersionOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# The one WiX this script builds with. Keep it equal to the one of .github/workflows/dist-msi.yml.
$WixVersion = '6.0.2'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Target = 'win32-x64'

function Resolve-Input([string] $Value, [string] $Default) {
  $path = if ([string]::IsNullOrEmpty($Value)) { Join-Path $Root $Default } else { $Value }
  return $path
}

if (-not $PSBoundParameters.ContainsKey('LauncherNoticesFile')) {
  $LauncherNoticesFile = Join-Path $Root 'native\job-launcher\THIRD_PARTY_NOTICES.md'
}
$Exe = Resolve-Input $Exe "dist\sea\$Target\otheater.exe"
$Launcher = Resolve-Input $Launcher 'native\job-launcher\target\release\ot-job-launcher.exe'
$NoticesFile = Resolve-Input $NoticesFile 'THIRD_PARTY_NOTICES.md'
$LicenseFile = Resolve-Input $LicenseFile 'LICENSE'
$ConfigFile = Resolve-Input $ConfigFile 'tools\release\release.config.json'
$OutDir = Resolve-Input $OutDir 'dist\msi'

# The semver of the build: the argument, else versionOverride, else the version of the daemon package.
function Get-SemVer {
  if (-not [string]::IsNullOrEmpty($Version)) { return $Version }
  $config = Get-Content -Raw -Path $ConfigFile | ConvertFrom-Json
  $override = $config.PSObject.Properties['versionOverride']
  if ($null -ne $override -and $null -ne $override.Value -and $override.Value -ne '') {
    return [string] $override.Value
  }
  $manifest = Get-Content -Raw -Path (Join-Path $Root 'packages\daemon\package.json') | ConvertFrom-Json
  return [string] $manifest.version
}

# The pattern of tools/release/src/config.ts (VERSION_PATTERN).
$SemVer = Get-SemVer
$match = [regex]::Match($SemVer, '^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$')
if (-not $match.Success) { throw "Version '$SemVer' is not a semver (1.2.3, 1.2.3-rc.1)" }
$major = [int64] $match.Groups[1].Value
$minor = [int64] $match.Groups[2].Value
$build = [int64] $match.Groups[3].Value
if ($major -gt 255 -or $minor -gt 255 -or $build -gt 65535) {
  throw "Version '$SemVer' does not fit an MSI ProductVersion (major and minor up to 255, build up to 65535)"
}
$MsiVersion = "$major.$minor.$build"
# The file name carries the semver without the build metadata (a '+' is awkward in a file name).
$FileSemVer = ($SemVer -split '\+')[0]
$MsiName = "OTheater-$FileSemVer-$Target.msi"

if ($PrintVersionOnly) {
  [ordered]@{ semver = $SemVer; msiVersion = $MsiVersion; file = $MsiName } | ConvertTo-Json -Compress
  return
}

function Get-InstalledWix {
  $command = Get-Command wix -ErrorAction SilentlyContinue
  if ($null -eq $command) { return $null }
  # `wix --version` prints `6.0.2+<commit>`.
  return ((& wix --version) | Select-Object -First 1).ToString().Trim()
}

$installed = Get-InstalledWix
if ($null -eq $installed -and $InstallWix) {
  & dotnet tool install --global wix --version $WixVersion
  if ($LASTEXITCODE -ne 0) { throw "dotnet tool install wix $WixVersion failed (exit $LASTEXITCODE)" }
  $installed = Get-InstalledWix
}
if ($null -eq $installed) {
  throw "wix is not installed. Install the pinned version: dotnet tool install --global wix --version $WixVersion"
}
if (-not $installed.StartsWith("$WixVersion")) {
  throw "wix $installed is installed, and this script is pinned to $WixVersion (dotnet tool uninstall --global wix, then dotnet tool install --global wix --version $WixVersion)"
}

$required = @{ Exe = $Exe; Launcher = $Launcher; NoticesFile = $NoticesFile; LicenseFile = $LicenseFile }
foreach ($name in $required.Keys) {
  if (-not (Test-Path -LiteralPath $required[$name] -PathType Leaf)) {
    throw "$name not found: $($required[$name])"
  }
}
$withLauncherNotices = -not [string]::IsNullOrEmpty($LauncherNoticesFile)
if ($withLauncherNotices -and -not (Test-Path -LiteralPath $LauncherNoticesFile -PathType Leaf)) {
  throw "LauncherNoticesFile not found: $LauncherNoticesFile"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$Msi = Join-Path (Resolve-Path $OutDir).Path $MsiName

$wixArgs = @(
  'build',
  '-arch', 'x64',
  '-d', "Version=$MsiVersion",
  '-d', "SemVer=$SemVer",
  '-d', "OtExe=$Exe",
  '-d', "JobLauncher=$Launcher",
  '-d', "License=$LicenseFile",
  '-d', "Notices=$NoticesFile"
)
if ($withLauncherNotices) { $wixArgs += @('-d', "LauncherNotices=$LauncherNoticesFile") }
$wixArgs += @('-o', $Msi, (Join-Path $PSScriptRoot 'Product.wxs'))

Write-Host "wix $installed, ProductVersion $MsiVersion (semver $SemVer) -> $Msi"
& wix @wixArgs
if ($LASTEXITCODE -ne 0) { throw "wix build failed (exit $LASTEXITCODE)" }

$hash = (Get-FileHash -Algorithm SHA256 -Path $Msi).Hash.ToLowerInvariant()
$size = (Get-Item $Msi).Length
Write-Host "$MsiName  $size bytes  sha256 $hash"
if ($env:GITHUB_OUTPUT) {
  "msi=$Msi" | Out-File -FilePath $env:GITHUB_OUTPUT -Append -Encoding utf8
  "semver=$SemVer" | Out-File -FilePath $env:GITHUB_OUTPUT -Append -Encoding utf8
}
