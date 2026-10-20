param([Parameter(Mandatory=$true)][string]$Payload)
$ErrorActionPreference = 'Stop'
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
$s = $p.state
$Root = [IO.Path]::GetFullPath($s.root)
$Disable = Join-Path $Root '.codex_discord_bot.disabled'
$Stop = Join-Path $Root '.codex_discord_rust.stop'
$Watchdog = Join-Path $Root 'codex-discord-rust-watchdog.ps1'
$Tray = Join-Path $Root 'codex-discord-tray.ps1'
$Manifest = Join-Path $Root '.cdr-ts-supervisor.json'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CdrCutoverArgv {
 [DllImport("shell32.dll", SetLastError=true)] public static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string value, out int count);
 [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr value);
 public static string[] Parse(string value) { int count; IntPtr memory=CommandLineToArgvW("placeholder "+value,out count); if(memory==IntPtr.Zero)throw new Exception("Command line parse failed"); try { var result=new string[count-1]; for(int i=1;i<count;i++) result[i-1]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory,i*IntPtr.Size)); return result; } finally { LocalFree(memory); } }
}
'@
function Identity($Process) {
 if ($null -eq $Process) { return $null }
 $ticks = $Process.StartTime.ToUniversalTime().Ticks
 return "$($Process.Id)|$($ticks-($ticks%10))"
}
function Legacy-Process {
 $lock = Join-Path $Root '.codex_discord_rust.runtime.lock'
 if (-not [IO.File]::Exists($lock)) { return $null }
 $fields = [IO.File]::ReadAllText($lock) | ConvertFrom-StringData
 $found = Get-Process -Id ([int]$fields.pid) -ErrorAction SilentlyContinue
 if ($null -eq $found) { return $null }
 if ([IO.Path]::GetFullPath($found.Path) -ine $s.binary) { throw 'Runtime lock is owned by a different executable.' }
 return $found
}
function Owned-LegacyAction($action) {
 if ([string]::IsNullOrWhiteSpace([string]$action.Execute)) { return $false }
 if ([IO.Path]::GetFullPath($action.Execute) -ieq $s.binary) { return $action.WorkingDirectory -ieq $Root }
 if ([IO.Path]::GetFileName($action.Execute) -notin @('powershell.exe','pwsh.exe')) { return $false }
 $parts = [CdrCutoverArgv]::Parse([string]$action.Arguments)
 $file = [Array]::IndexOf($parts,'-File'); if ($file -lt 0 -or $file+1 -ge $parts.Count) { return $false }
 if ([IO.Path]::GetFullPath($parts[$file+1]) -notin @($Watchdog,$Tray)) { return $false }
 $rootIndex = [Array]::IndexOf($parts,'-RepoRoot')
 if ($rootIndex -ge 0 -and ($rootIndex+1 -ge $parts.Count -or [IO.Path]::GetFullPath($parts[$rootIndex+1]) -ine $Root)) { return $false }
 foreach ($binding in @(@('-BinaryPath',$s.binary),@('-EnvPath',$s.env))) { $i=[Array]::IndexOf($parts,$binding[0]); if ($i -ge 0 -and ($i+1 -ge $parts.Count -or [IO.Path]::GetFullPath($parts[$i+1]) -ine $binding[1])) { return $false } }
 return $true
}
function Task-Definition($task) { return ([ordered]@{ Actions=@($task.Actions | Select-Object Execute,Arguments,WorkingDirectory); Principal=$task.Principal | Select-Object UserId,LogonType,RunLevel; Triggers=@($task.Triggers | Select-Object @{Name='Type';Expression={$_.CimClass.CimClassName}},Enabled,StartBoundary,EndBoundary) } | ConvertTo-Json -Depth 8 -Compress) }
function Assert-Task($record) {
 $task = Get-ScheduledTask -TaskPath $record.path -TaskName $record.name -ErrorAction Stop
 if ((Task-Definition $task) -cne $record.definition) { throw 'Legacy scheduled task changed after inventory.' }
 return $task
}
function Assert-TargetTask {
 $task = Get-ScheduledTask -TaskName $s.taskName -ErrorAction SilentlyContinue
 if ($null -eq $task) { return $null }
 if (@($task).Count -ne 1 -or @($task.Actions).Count -ne 1 -or $task.Actions[0].Execute -ine $s.node -or $task.Actions[0].Arguments -cne $s.taskArguments -or $task.Actions[0].WorkingDirectory -ine $Root) { throw 'TS task belongs to another installation.' }
 return $task
}
function Legacy-RestartTask($Records) {
 foreach ($record in @($Records)) {
  if (-not $record.enabled) { continue }
  $task=Assert-Task $record
  foreach ($action in @($task.Actions)) {
   if (-not (Owned-LegacyAction $action)) { continue }
   if ([IO.Path]::GetFullPath($action.Execute) -ieq $s.binary) { return $record }
   $parts=[CdrCutoverArgv]::Parse([string]$action.Arguments); $file=[Array]::IndexOf($parts,'-File')
   if ($file -ge 0 -and $file+1 -lt $parts.Count -and [IO.Path]::GetFullPath($parts[$file+1]) -ieq $Watchdog) { return $record }
  }
 }
 return $null
}
function Start-RestoredLegacy($Record) {
 if ($null -eq $Record) { throw 'Automatic rollback requires an originally enabled legacy watchdog/runtime task.' }
 [void](Assert-Task $Record)
 # Task Scheduler owns the restored runtime. Launching the watchdog as our child
 # would place Rust in the cutover command job, which is killed on command close.
 if ($null -eq (Legacy-Process)) { Start-ScheduledTask -TaskPath $Record.path -TaskName $Record.name }
 [void](Wait-Healthy $false)
}
function Invoke-Node([string[]]$Arguments) {
 $lines = & $s.node @Arguments
 if ($LASTEXITCODE -ne 0) { throw "TS command failed: $($Arguments[1])" }
 return ($lines -join "`n")
}
function Remove-Owned([string]$Path,[string]$Text) { if ([IO.File]::Exists($Path)) { if ([IO.File]::ReadAllText($Path) -cne $Text) { throw 'Foreign maintenance marker preserved.' }; [IO.File]::Delete($Path) } }
function Target-State {
 if (-not [IO.File]::Exists($Manifest)) { return $null }
 $state = [IO.File]::ReadAllText($Manifest) | ConvertFrom-Json
 if ($state.version -ne 1 -or $state.root -ine $Root -or $state.entry -ine $s.entry -or $state.node -ine $s.node) { throw 'Supervisor belongs to another installation.' }
 return $state
}
function Wait-Healthy([bool]$Target) {
 $until = (Get-Date).AddSeconds(150); $healthySince=$null; $bound=$null
 do {
  $state = if ($Target) { Target-State } else { $null }
  $process = if ($Target -and $null -ne $state -and $null -ne $state.childPid) { Get-Process -Id $state.childPid -ErrorAction SilentlyContinue } elseif (-not $Target) { Legacy-Process } else { $null }
  if ($null -ne $process) {
   if ($Target -and $process.Path -ine $s.node) { throw 'Target runtime executable differs.' }
   $identity = Identity $process
   if ($null -ne $bound -and $bound -ne $identity) { throw 'Runtime was replaced during observation.' }
   $heartbeat=Join-Path $Root '.codex_discord_rust.heartbeat'
   if ([IO.File]::Exists($heartbeat)) {
    $fields=[IO.File]::ReadAllText($heartbeat) | ConvertFrom-StringData
    $age=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()-[long]$fields.updated_at
    if ([int]$fields.pid -eq $process.Id -and $age -ge 0 -and $age -le 45 -and [long]$fields.updated_at -ge ([DateTimeOffset]$process.StartTime.ToUniversalTime()).ToUnixTimeSeconds()) {
     if ($null -eq $healthySince) { $healthySince=Get-Date; $bound=$identity }
     if (((Get-Date)-$healthySince).TotalSeconds -ge 10) { return @{ identity=$bound; nonce=if($Target){$state.nonce}else{$null} } }
    } elseif ($null -ne $healthySince) { throw 'Runtime heartbeat became unhealthy.' }
   }
  }
  Start-Sleep -Milliseconds 250
 } while ((Get-Date) -lt $until)
 throw 'Runtime did not become healthy.'
}
if ($p.action -eq 'inventory') {
 foreach ($path in @($Disable,$Stop,$Manifest,(Join-Path $Root '.codex_discord_rust.restart'),(Join-Path $Root '.codex_discord_rust.drain.prepare'),(Join-Path $Root '.codex_discord_rust.drain.ack'))) { if (Test-Path -LiteralPath $path) { throw 'Existing runtime/maintenance state must be resolved before cutover.' } }
 if ($null -ne (Get-ScheduledTask -TaskName $s.taskName -ErrorAction SilentlyContinue)) { throw 'Existing TS startup task preserved.' }
 $tasks=@(); foreach ($task in (Get-ScheduledTask)) { $owned=@($task.Actions | Where-Object { Owned-LegacyAction $_ }); if ($owned.Count -eq 0) { continue }; if ($owned.Count -ne @($task.Actions).Count) { throw 'Mixed-action legacy task requires explicit operator review.' }; $tasks+=@{ name=$task.TaskName; path=$task.TaskPath; enabled=$task.Settings.Enabled; definition=(Task-Definition $task); xml=(Export-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath) } }
 @{ legacyIdentity=(Identity (Legacy-Process)); tasks=$tasks } | ConvertTo-Json -Depth 12 -Compress
 exit 0
}
if ($p.action -eq 'preflight') {
 foreach ($file in @($s.binary,$s.env,$Watchdog,(Join-Path $Root 'codex-discord-rust-control.ps1'),$s.entry)) { if (-not [IO.File]::Exists($file)) { throw 'A cutover prerequisite is missing.' } }
 if ($s.inventory.legacyIdentity -and $null -eq (Legacy-RestartTask $s.inventory.tasks)) { throw 'Running Rust needs an originally enabled watchdog/runtime task for automatic rollback; no changes made.' }
 [void](Invoke-Node @($s.entry,'--check-config','--env',$s.env)); 'null'; exit 0
}
if ($p.action -eq 'backup') { $text=Invoke-Node @($s.entry,'--backup-store','--env',$s.env); if ($text -notmatch 'backup_created path=(.+)') { throw 'Verified backup receipt missing.' }; ConvertTo-Json -InputObject $Matches[1] -Compress; exit 0 }
if ($p.action -eq 'migrate-store') { $result=(Invoke-Node @($s.entry,'--admin','migrate-mirror-cursors','--repo-root',$Root,'--env',$s.env)) | ConvertFrom-Json; if (@($result.held).Count -gt 0) { throw 'Mirror continuity could not be verified; historical requests were not replayed.' }; $result | ConvertTo-Json -Depth 8 -Compress; exit 0 }
if ($p.action -eq 'install-target') { [void](Invoke-Node @($s.entry,'--install-startup','--runtime-root',$Root,'--env',$s.env)); [void](Assert-TargetTask); 'null'; exit 0 }
if ($p.action -eq 'start-target') { [void](Assert-TargetTask); Start-ScheduledTask -TaskName $s.taskName; 'null'; exit 0 }
if ($p.action -eq 'observe-target') { Wait-Healthy $true | ConvertTo-Json -Compress; exit 0 }
if ($p.action -eq 'stop-target') {
 $task=Assert-TargetTask
 if ($null -ne $task) { Disable-ScheduledTask -TaskName $s.taskName | Out-Null }
 $state=Target-State
 if ($null -ne $state) { [void](Invoke-Node @($s.entry,'--supervisor-control','stop','--runtime-root',$Root)); $until=(Get-Date).AddSeconds(30); while ([IO.File]::Exists($Manifest) -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 100 }; if ([IO.File]::Exists($Manifest)) { throw 'Target stop is unconfirmed; source remains fenced.' }; Remove-Owned $Stop "supervisor_stop`n" }
 if ($null -ne $task) { $current=Assert-TargetTask; if ($current.State -eq 'Running') { throw 'Target scheduled task has not joined.' }; Unregister-ScheduledTask -TaskName $s.taskName -Confirm:$false }
 # A missing supervisor record cannot prove an orphaned Node runtime has exited.
 $lock=Join-Path $Root '.codex_discord_rust.runtime.lock'
 if ([IO.File]::Exists($lock)) { $fields=[IO.File]::ReadAllText($lock)|ConvertFrom-StringData; $process=Get-Process -Id ([int]$fields.pid) -ErrorAction SilentlyContinue; if ($null -ne $process -and $process.Path -ine $s.binary) { throw 'Unsupervised target ownership remains; source remains fenced.' } }
 'null'; exit 0
}
. (Join-Path $Root 'codex-discord-rust-control.ps1')
if ($p.action -eq 'prepare') {
 $control=Enter-CdrControl -Root $Root
 try {
  Assert-CdrNoPendingRestart -Root $Root
  if ((Identity (Legacy-Process)) -ne $s.inventory.legacyIdentity) { throw 'Legacy runtime changed since inventory.' }
  foreach ($record in @($s.inventory.tasks)) { [void](Assert-Task $record) }
  Write-NewCdrMarker -Path $Disable -Text $s.disableText
  Write-NewCdrMarker -Path $Stop -Text $s.stopText
  foreach ($record in @($s.inventory.tasks)) { Disable-ScheduledTask -TaskPath $record.path -TaskName $record.name | Out-Null }
 } finally { $control.Dispose() }
 'null'; exit 0
}
if ($p.action -eq 'stop-legacy') {
 & $Watchdog -RepoRoot $Root -BinaryPath $s.binary -EnvPath $s.env | Out-Null
 if ($LASTEXITCODE -ne 0 -or $null -ne (Legacy-Process)) { throw 'Legacy shutdown did not complete.' }
 $control=Enter-CdrControl -Root $Root
 try { Assert-CdrMarkerOwner -Path $Disable -Text $s.disableText; Remove-Owned $Stop $s.stopText } finally { $control.Dispose() }
 foreach ($record in @($s.inventory.tasks)) { $task=Assert-Task $record; if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskPath $record.path -TaskName $record.name } }
 foreach ($process in (Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'")) {
  if ($process.ProcessId -eq $PID -or -not $process.CommandLine) { continue }
  $parts=[CdrCutoverArgv]::Parse($process.CommandLine); $index=[Array]::IndexOf($parts,'-File')
  if ($index -ge 0 -and $index+1 -lt $parts.Count -and $parts[$index+1] -ieq $Tray -and (Owned-LegacyAction ([pscustomobject]@{Execute=$process.ExecutablePath;Arguments=$process.CommandLine}))) {
   $candidate=Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
   if ($null -ne $candidate) { $ticks=$candidate.StartTime.ToUniversalTime().Ticks; $observed=$process.CreationDate.ToUniversalTime().Ticks; if (($ticks-($ticks%10)) -eq ($observed-($observed%10))) { Stop-Process -Id $candidate.Id -ErrorAction Stop } }
  }
 }
 'null'; exit 0
}
if ($p.action -eq 'restore-legacy') {
 if ($null -ne (Target-State)) { throw 'Target supervisor still exists; rollback refused.' }
 $restartTask=$null
 if ($s.inventory.legacyIdentity) { $restartTask=Legacy-RestartTask $s.inventory.tasks; if ($null -eq $restartTask) { throw 'Legacy restart task unavailable; source remains fenced.' } }
 $control=Enter-CdrControl -Root $Root
 try {
  foreach ($record in @($s.inventory.tasks)) { [void](Assert-Task $record) }
  Remove-Owned $Stop $s.stopText
  Remove-Owned $Disable $s.disableText
  foreach ($record in @($s.inventory.tasks)) { if ($record.enabled) { Enable-ScheduledTask -TaskPath $record.path -TaskName $record.name | Out-Null } }
 } finally { $control.Dispose() }
 if ($s.inventory.legacyIdentity) { Start-RestoredLegacy $restartTask }
 'null'; exit 0
}
throw 'Unknown cutover action.'
