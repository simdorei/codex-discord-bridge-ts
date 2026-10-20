[CmdletBinding()]
param(
    [string]$RepoRoot,
    [switch]$DryRun,
    [switch]$Immediate,
    [switch]$Force,
    [switch]$Deferred,
    [string]$ExpectedBotIdentity,
    [string]$ExpectedRuntimeId,
    [int]$DelaySeconds = 10,
    [int]$QuietSeconds = 90,
    [int]$WaitTimeoutSeconds = 900
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
    if ($DryRun) { $State | ConvertTo-Json -Compress; exit 0 }
    $Identity = Get-Content -LiteralPath (Join-Path $RepoRoot '.codex_discord_rust.drain.identity') -Raw -Encoding UTF8 | ConvertFrom-StringData
    if ($Identity.version -ne '1' -or $Identity.state -ne 'open' -or [int]$Identity.pid -ne $State.childPid) { throw 'Runtime identity differs.' }
    if ($ExpectedBotIdentity) {
        $OwnedProcess = Get-Process -Id $State.childPid -ErrorAction Stop
        $Ticks = $OwnedProcess.StartTime.ToUniversalTime().Ticks
        $RoundedTicks = $Ticks - ($Ticks % 10)
        if ($ExpectedBotIdentity -ne "$($State.childPid)|$RoundedTicks") { throw 'Expected bot identity differs.' }
    }
    if ($ExpectedRuntimeId -and $ExpectedRuntimeId -ne $Identity.runtime_id) { throw 'Expected runtime generation differs.' }
    $Action = if ($Force) { 'force_restart' } else { 'restart' }
    $ControlArguments = @($State.entry, '--supervisor-control', $Action, '--runtime-root', $RepoRoot)
    $ControlArguments += @('--expected-runtime', $Identity.runtime_id)
    if (-not $Force) {
        $Delay = if ($Immediate) { 0 } else { $DelaySeconds }
        $ControlArguments += @('--delay-seconds', "$Delay", '--restart-quiet-seconds', "$QuietSeconds", '--restart-wait-timeout-seconds', "$WaitTimeoutSeconds")
    }
    & $State.node @ControlArguments
    exit $LASTEXITCODE
}
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..\bin\codex-discord-bridge.mjs')) { throw 'No TS watchdog is registered for this root. Start codex-discord-bridge --start --runtime-root <root> first.' }
$RuntimeModePath = Join-Path $RepoRoot '.codex_discord_runtime'
$RuntimeMode = [string]$env:CODEX_DISCORD_RUNTIME
if ([string]::IsNullOrWhiteSpace($RuntimeMode) -and (Test-Path -LiteralPath $RuntimeModePath)) {
    $RuntimeMode = (Get-Content -LiteralPath $RuntimeModePath -Raw).Trim()
}
if ([string]::IsNullOrWhiteSpace($RuntimeMode)) {
    $RuntimeMode = 'rust'
}
if ($RuntimeMode -eq 'rust') {
    if ($Force) { throw 'Use the Rust force-restart entry point when no TS supervisor is registered.' }
    & (Join-Path $RepoRoot 'codex-discord-rust-restart.ps1') `
        -RepoRoot $RepoRoot `
        -DryRun:$DryRun `
        -Immediate:$Immediate `
        -Deferred:$Deferred `
        -ExpectedBotIdentity $ExpectedBotIdentity `
        -DelaySeconds $DelaySeconds `
        -QuietSeconds $QuietSeconds `
        -WaitTimeoutSeconds $WaitTimeoutSeconds
    exit $LASTEXITCODE
}
throw "This installation only supports the Rust runtime; unsupported selection: '$RuntimeMode'."
