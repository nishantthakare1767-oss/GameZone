[CmdletBinding()]
param(
    [string]$KioskAccount,
    [string]$InstallRoot = 'C:\Program Files\GameHub',
    [string]$DataRoot = 'C:\ProgramData\GameHub',
    [switch]$KeepData
)

$ErrorActionPreference = 'Stop'

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
        ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script from an elevated PowerShell prompt.'
}

$service = Get-Service -Name 'GameHubAgent' -ErrorAction SilentlyContinue
if ($service) {
    Stop-Service -Name 'GameHubAgent' -Force -ErrorAction SilentlyContinue
    sc.exe delete GameHubAgent | Out-Null
    Write-Host 'Service removed.'
}

if ($KioskAccount) {
    $user = Get-LocalUser -Name $KioskAccount -ErrorAction SilentlyContinue
    if ($user) {
        $shellKey = "Registry::HKEY_USERS\$($user.SID.Value)\Software\Microsoft\Windows NT\CurrentVersion\Winlogon"
        if (Test-Path $shellKey) {
            Set-ItemProperty -Path $shellKey -Name 'Shell' -Value 'explorer.exe'
            Write-Host "Restored explorer.exe as the shell for $KioskAccount."
        }
    }
}

Remove-Item -Recurse -Force $InstallRoot -ErrorAction SilentlyContinue
if (-not $KeepData) {
    Remove-Item -Recurse -Force $DataRoot -ErrorAction SilentlyContinue
}

Write-Host 'Uninstalled.'
