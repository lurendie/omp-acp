<#
.SYNOPSIS
  Remove the OMP Agent entries from Zed settings and delete the bridge script.
  Keeps the settings backup created by install.ps1.
#>
param(
  [string]$SettingsPath = "",
  [string]$BridgePath = ""
)

$ErrorActionPreference = "Stop"

if (-not $SettingsPath) { $SettingsPath = Join-Path $env:APPDATA "Zed\settings.json" }
if (-not $BridgePath) { $BridgePath = Join-Path $env:USERPROFILE ".omp\zed\bridge.cjs" }

Write-Host "==> Removing Zed settings entries" -ForegroundColor Cyan
if (Test-Path $SettingsPath) {
  # repo layout: this file lives in scripts/, so the helper is in the same dir
  $remove = Join-Path $PSScriptRoot "merge-settings.cjs"
  & node $remove remove --file $SettingsPath --keys "agent_servers.omp,context_servers.omp"
} else {
  Write-Host "    no settings file at $SettingsPath"
}

Write-Host "==> Removing bridge script" -ForegroundColor Cyan
if (Test-Path $BridgePath) {
  Remove-Item $BridgePath -Force
  Write-Host "    removed $BridgePath"
} else {
  Write-Host "    no bridge at $BridgePath"
}

Write-Host "==> Done. Also remove the extension in Zed (Extensions panel) and delete the repo folder if desired." -ForegroundColor Green
