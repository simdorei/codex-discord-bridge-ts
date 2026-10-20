[CmdletBinding()]
param([string]$RepoRoot, [switch]$SkipUnitTests)
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($RepoRoot)) { $RepoRoot = Join-Path $PSScriptRoot '..' }
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$Entry = Join-Path $RepoRoot 'bin/codex-discord-bridge.mjs'
foreach ($Relative in @('package.json', 'bin/codex-discord-bridge.mjs', 'dist/src/cli/local-runtime.js', 'dist/src/runtime/windows/supervisor.js', 'dist/src/remote-agent/native-project.js', 'dist/src/cli/admin-database-worker.js', 'scripts/Invoke-CdrDesktopRecovery.ps1')) {
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot $Relative) -PathType Leaf)) { throw "Missing package asset: $Relative" }
}
& $Node $Entry --version
if ($LASTEXITCODE -ne 0) { throw 'Installed Node/package version check failed.' }
& $Node $Entry --help
if ($LASTEXITCODE -ne 0) { throw 'Installed CLI help check failed.' }
$TestsAvailable = Test-Path -LiteralPath (Join-Path $RepoRoot 'tools/run-tests.mjs') -PathType Leaf
$RanTests = $false
if ($TestsAvailable -and -not $SkipUnitTests) {
    Push-Location -LiteralPath $RepoRoot
    try {
        & $Node tools/run-tests.mjs --profile windows-features
        if ($LASTEXITCODE -ne 0) { throw 'Windows feature tests failed.' }
        $RanTests = $true
    } finally { Pop-Location }
}
[ordered]@{ package_assets_verified = $true; test_sources_available = $TestsAvailable; tests_run = $RanTests; live_service_tested = $false } | ConvertTo-Json -Compress
