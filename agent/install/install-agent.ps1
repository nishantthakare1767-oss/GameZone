<#
.SYNOPSIS
  Installs the GameHub agent service and configures a kiosk account.

.DESCRIPTION
  Run from an elevated PowerShell prompt on the gaming PC, after publishing both
  projects with `dotnet publish -c Release`.

.EXAMPLE
  .\install-agent.ps1 -ServerUrl http://192.168.1.10:4000 -DeviceId 6f1c... -EnrollmentCode GHUB-1A2B-3C4D -KioskAccount GameHubPlayer
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ServerUrl,
    [Parameter(Mandatory = $true)][string]$EnrollmentCode,
    [Parameter(Mandatory = $true)][string]$KioskAccount,
    [Parameter(Mandatory = $true)][guid]$DeviceId,
    [string]$InstallRoot = 'C:\Program Files\GameHub',
    [string]$DataRoot = 'C:\ProgramData\GameHub',
    [string]$PublishRoot = (Join-Path $PSScriptRoot '..'),
    [string]$Launcher = 'explorer.exe'
)

$ErrorActionPreference = 'Stop'

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
        ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script from an elevated PowerShell prompt.'
}

$serviceSource = Join-Path $PublishRoot 'GameHub.Agent.Service\bin\Release\net8.0-windows\win-x64\publish'
$hostSource = Join-Path $PublishRoot 'GameHub.Agent.SessionHost\bin\Release\net8.0-windows\win-x64\publish'

foreach ($path in @($serviceSource, $hostSource)) {
    if (-not (Test-Path $path)) {
        throw "Publish output not found: $path. Run 'dotnet publish -c Release' first."
    }
}

Write-Host 'Creating folders…'
New-Item -ItemType Directory -Force -Path $InstallRoot, $DataRoot | Out-Null

Write-Host 'Copying binaries…'
Copy-Item -Recurse -Force (Join-Path $serviceSource '*') $InstallRoot
Copy-Item -Recurse -Force (Join-Path $hostSource '*') (Join-Path $InstallRoot 'SessionHost')

$deviceId = $DeviceId
$config = [ordered]@{
    Logging = @{ LogLevel = @{ Default = 'Information' } }
    Agent   = [ordered]@{
        ServerUrl       = $ServerUrl.TrimEnd('/')
        DeviceId        = $deviceId.ToString()
        EnrollmentCode  = $EnrollmentCode
        HeartbeatSeconds = 15
        OfflineRetrySeconds = 5
        GraceSeconds    = 900
        PipeName        = 'gamehub-agent'
        DataDirectory   = $DataRoot
    }
}
$configPath = Join-Path $InstallRoot 'agent.json'
$config | ConvertTo-Json -Depth 6 | Set-Content -Path $configPath -Encoding UTF8

Write-Host "Using device id $deviceId from the dashboard."

Write-Host 'Registering the Windows service…'
$existing = Get-Service -Name 'GameHubAgent' -ErrorAction SilentlyContinue
if ($existing) {
    Stop-Service -Name 'GameHubAgent' -Force -ErrorAction SilentlyContinue
    sc.exe delete GameHubAgent | Out-Null
}
New-Service -Name 'GameHubAgent' `
    -BinaryPathName "`"$InstallRoot\GameHub.Agent.Service.exe`"" `
    -DisplayName 'GameHub Device Agent' `
    -Description 'Reports heartbeats and session authorization for this gaming PC.' `
    -StartupType Automatic

# The service needs write access to its data folder for the DPAPI token.
icacls $DataRoot /grant 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null

Write-Host 'Configuring the kiosk account shell…'
$sessionHost = Join-Path $InstallRoot 'SessionHost\GameHub.Agent.SessionHost.exe'
$user = Get-LocalUser -Name $KioskAccount -ErrorAction Stop
$sid = $user.SID.Value
$shellKey = "Registry::HKEY_USERS\$sid\Software\Microsoft\Windows NT\CurrentVersion\Winlogon"
if (-not (Test-Path $shellKey)) {
    New-Item -Path $shellKey -Force | Out-Null
}
Set-ItemProperty -Path $shellKey -Name 'Shell' -Value "`"$sessionHost`""
[Environment]::SetEnvironmentVariable('GAMEHUB_LAUNCHER', $Launcher, 'Machine')
[Environment]::SetEnvironmentVariable('GAMEHUB_STATION', $env:COMPUTERNAME, 'Machine')

Write-Host 'Starting the service…'
Start-Service -Name 'GameHubAgent'

Write-Host ''
Write-Host 'Installed. Next steps:' -ForegroundColor Green
Write-Host '  1. Confirm the PC shows "Online" on the dashboard within a minute.'
Write-Host '  2. Sign in as the kiosk account to test the session screen.'
Write-Host '  3. Give the kiosk account NO local administrator rights.'
Write-Host '  4. See docs/windows-agent.md for policy hardening (AppLocker, Ctrl+Alt+Del options).'
