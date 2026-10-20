[CmdletBinding()]
param(
    [string]$RuntimeRoot = (Join-Path $env:LOCALAPPDATA 'CodexDiscordTS\runtime')
)
$ErrorActionPreference = 'Stop'
$RuntimeRoot = (Resolve-Path -LiteralPath $RuntimeRoot -ErrorAction Stop).ProviderPath
$EnvPath = Join-Path $RuntimeRoot '.env'
$item = Get-Item -LiteralPath $EnvPath -Force -ErrorAction Stop
if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Expected an existing regular .env file.'
}
$original = [IO.File]::ReadAllBytes($EnvPath)
$utf8 = New-Object Text.UTF8Encoding($false, $true)
$text = $utf8.GetString($original).TrimStart([char]0xFEFF)
$updates = [ordered]@{
    DISCORD_SESSION_MIRROR = '1'
    DISCORD_STARTUP_NOTIFY = '1'
}
$seen = @{}
$lines = New-Object 'System.Collections.Generic.List[string]'
foreach ($line in [regex]::Split($text, '\r\n|\n|\r')) {
    $match = [regex]::Match($line, '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=')
    $key = $match.Groups[1].Value
    if ($match.Success -and $updates.Contains($key)) {
        if (-not $seen.ContainsKey($key)) { $lines.Add($key + '=' + $updates[$key]) }
        $seen[$key] = $true
    } else {
        $lines.Add($line)
    }
}
while ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') { $lines.RemoveAt($lines.Count - 1) }
foreach ($key in $updates.Keys) {
    if (-not $seen.ContainsKey($key)) { $lines.Add($key + '=' + $updates[$key]) }
}
$replacement = $utf8.GetBytes(($lines -join "`r`n") + "`r`n")
if ([Convert]::ToBase64String($replacement) -eq [Convert]::ToBase64String($original)) {
    Write-Output 'Rust mirroring and startup notice defaults are already set.'
    return
}
$suffix = [Guid]::NewGuid().ToString('N')
$temporary = Join-Path $RuntimeRoot ('.env.rust-defaults-' + $suffix + '.tmp')
$backup = Join-Path $RuntimeRoot ('.env.before-rust-defaults-' + $suffix)
try {
    [IO.File]::WriteAllBytes($temporary, $replacement)
    if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($EnvPath)) -ne [Convert]::ToBase64String($original)) {
        throw 'The environment changed during repair; no settings were replaced.'
    }
    [IO.File]::Replace($temporary, $EnvPath, $backup)
} finally {
    if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
}
Write-Output 'Restored DISCORD_SESSION_MIRROR=1 and DISCORD_STARTUP_NOTIFY=1.'
Write-Output ('Local backup: ' + $backup)
Write-Output 'Run --check-config, then restart the configured TS runtime to apply these settings.'
