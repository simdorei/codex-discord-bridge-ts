[CmdletBinding()]
param(
    [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = if ($env:CODEX_DISCORD_ROOT) { $env:CODEX_DISCORD_ROOT } elseif (Test-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..\bin\codex-discord-bridge.mjs')) { (Get-Location).Path } else { Join-Path $PSScriptRoot '..\..\..' }
}

$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
$Supervisor = Join-Path $RepoRoot '.cdr-ts-supervisor.json'
if (Test-Path -LiteralPath $Supervisor) {
    $State = Get-Content -LiteralPath $Supervisor -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($State.version -ne 1 -or $State.root -ine $RepoRoot) { throw 'Supervisor binding differs.' }
    & $State.node $State.entry --supervisor-status --runtime-root $RepoRoot
    exit $LASTEXITCODE
}
$PackageEntry = Join-Path $PSScriptRoot '..\..\..\bin\codex-discord-bridge.mjs'
if (Test-Path -LiteralPath $PackageEntry) {
    $IdentityPath = Join-Path $RepoRoot '.codex_discord_rust.drain.identity'
    $Identity = if (Test-Path -LiteralPath $IdentityPath) { Get-Content -LiteralPath $IdentityPath -Raw -Encoding UTF8 } else { $null }
    [ordered]@{ runtime = 'typescript'; watchdog = $false; root = $RepoRoot; recorded_identity = $Identity; live_process_verified = $false } | ConvertTo-Json -Compress
    exit 0
}
$RuntimeModePath = Join-Path $RepoRoot '.codex_discord_runtime'
$RuntimeMode = [string]$env:CODEX_DISCORD_RUNTIME
if ([string]::IsNullOrWhiteSpace($RuntimeMode) -and (Test-Path -LiteralPath $RuntimeModePath)) {
    $RuntimeMode = (Get-Content -LiteralPath $RuntimeModePath -Raw).Trim()
}
if ([string]::IsNullOrWhiteSpace($RuntimeMode)) {
    $RuntimeMode = 'rust'
}
if ($RuntimeMode -eq 'rust') {
    & (Join-Path $RepoRoot 'codex-discord-rust-status.ps1') -RepoRoot $RepoRoot
    exit $LASTEXITCODE
}
throw "This installation only supports the Rust runtime; unsupported selection: '$RuntimeMode'."
