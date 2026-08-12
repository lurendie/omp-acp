<#
.SYNOPSIS
  Install the OMP Agent for Zed: register `omp acp` as an External Agent and
  the `omp` MCP context server (bridge), copy the bridge script, and verify
  the ACP handshake.

.DESCRIPTION
  Steps:
    1. Locate the omp executable (parameter -> PATH -> %LOCALAPPDATA%\omp -> ~/.omp/bin).
    2. Verify `omp --version`.
    3. Copy bridge/server.cjs to ~/.omp/zed/bridge.cjs.
    4. ACP handshake test against `omp acp` (skippable with -SkipAcpCheck).
    5. Merge agent_servers.omp + context_servers.omp into Zed settings.json
       (backup written first).
  Then install the extension in Zed: command palette -> `zed: install dev
  extension` -> select this repository folder. Restart Zed.

.EXAMPLE
  .\install.ps1
  .\install.ps1 -OmpPath "C:\Users\you\AppData\Local\omp\omp.exe" -Model "opencode-go/deepseek-v4-flash"
  .\install.ps1 -AutoConfirm
#>
param(
  [string]$OmpPath = "",
  [string]$SettingsPath = "",
  [string]$Model = "",
  [switch]$AutoConfirm,
  [string]$SessionDir = "",
  [string]$BridgeDest = "",
  [switch]$SkipAcpCheck
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }

# --- 1. locate omp -----------------------------------------------------------
Write-Step "Locating omp"
if (-not $OmpPath) {
  $cmd = Get-Command omp -ErrorAction SilentlyContinue
  if ($cmd) { $OmpPath = $cmd.Source }
}
if (-not $OmpPath) {
  foreach ($p in @("$env:LOCALAPPDATA\omp\omp.exe", "$env:USERPROFILE\.omp\bin\omp.exe", "$env:USERPROFILE\.local\bin\omp.exe")) {
    if (Test-Path $p) { $OmpPath = $p; break }
  }
}
if (-not $OmpPath -or -not (Test-Path $OmpPath)) {
  throw "omp not found. Install omp first, or pass -OmpPath <path>."
}
$OmpPath = (Resolve-Path $OmpPath).Path
$version = (& $OmpPath --version 2>$null | Select-Object -First 1)
if (-not $version) { throw "`"$OmpPath --version`" failed — is this the omp binary?" }
Write-Ok "$OmpPath ($version)"

# --- 2. node for the merge/handshake helpers ---------------------------------
Write-Step "Checking node"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "node not found on PATH — required by the installer helpers (Zed bundles its own node for the bridge itself)." }
Write-Ok $node.Source

# --- 3. copy the bridge ------------------------------------------------------
Write-Step "Installing bridge script"
if (-not $BridgeDest) { $BridgeDest = Join-Path $env:USERPROFILE ".omp\zed\bridge.cjs" }
$bridgeSource = Join-Path $repoRoot "bridge\server.cjs"
if (-not (Test-Path $bridgeSource)) { throw "bridge not found at $bridgeSource" }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $BridgeDest) | Out-Null
Copy-Item $bridgeSource $BridgeDest -Force
Write-Ok "$bridgeSource -> $BridgeDest"

# --- 4. ACP handshake --------------------------------------------------------
if (-not $SkipAcpCheck) {
  Write-Step "Verifying ACP handshake (omp acp)"
  $handshake = Join-Path $PSScriptRoot "acp-handshake.cjs"
  & node $handshake -omp $OmpPath
  if ($LASTEXITCODE -ne 0) { throw "ACP handshake failed — check the omp installation." }
  Write-Ok "ACP initialize round-trip OK"
}

# --- 5. merge Zed settings ---------------------------------------------------
Write-Step "Updating Zed settings"
if (-not $SettingsPath) { $SettingsPath = Join-Path $env:APPDATA "Zed\settings.json" }
if (Test-Path $SettingsPath) {
  $backup = "$SettingsPath.omp-acp.bak"
  Copy-Item $SettingsPath $backup -Force
  Write-Ok "backup: $backup"
} else {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $SettingsPath) | Out-Null
  Write-Ok "no existing settings file; creating $SettingsPath"
}

$agentServer = @{ type = "custom"; command = $OmpPath; args = @("acp") }
$csSettings = @{}
if ($Model) { $csSettings["model"] = $Model }
if ($AutoConfirm) { $csSettings["autoConfirm"] = $true }
if ($SessionDir) { $csSettings["sessionDir"] = $SessionDir }
$patch = @{
  agent_servers   = @{ omp = $agentServer }
  context_servers = @{ omp = @{ enabled = $true; remote = $false; settings = $csSettings } }
}
$merge = Join-Path $PSScriptRoot "merge-settings.cjs"
$patch | ConvertTo-Json -Depth 8 -Compress | & node $merge merge --file $SettingsPath --json -
if ($LASTEXITCODE -ne 0) { throw "settings merge failed" }
Write-Ok "agent_servers.omp -> $OmpPath acp"
Write-Ok "context_servers.omp -> enabled (bridge)"

Write-Step "Done. Next steps:"
Write-Host "  1. In Zed: command palette -> 'zed: install dev extension' -> select: $repoRoot"
Write-Host "  2. Restart Zed (or run 'zed: reload workspace')."
Write-Host "  3. Agent Panel -> New Thread -> pick OMP; Settings -> AI -> MCP Servers: 'omp' should be active."
Write-Host "  4. Uninstall: .\uninstall.ps1"
