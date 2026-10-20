param([Parameter(Mandatory=$true)][string]$Payload)
$ErrorActionPreference = 'Stop'
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.SystemIcons]::Application
$icon.Text = 'Codex Discord TS'
$menu = New-Object System.Windows.Forms.ContextMenuStrip
function Invoke-Control([string]$Arguments) {
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $p.node
    $start.Arguments = $Arguments
    $start.WorkingDirectory = $p.root
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $start
    try {
        [void]$process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(15000)) { $process.Kill(); throw 'Control command did not finish.' }
        $text = if ($process.ExitCode -eq 0) { $stdout.Result } else { $stderr.Result }
        [void][System.Windows.Forms.MessageBox]::Show($text, 'Codex Discord TS')
    } catch { [void][System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Codex Discord TS') }
    finally { $process.Dispose() }
}
$status = $menu.Items.Add('Status')
$status.Add_Click({ Invoke-Control $p.status })
$logs = $menu.Items.Add('Open logs folder')
$logs.Add_Click({ (New-Object -ComObject Shell.Application).Open($p.root) })
$restart = $menu.Items.Add('Restart after drain')
$restart.Add_Click({ Invoke-Control $p.restart })
$force = $menu.Items.Add('Force restart')
$force.Add_Click({ Invoke-Control $p.force })
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$exit = $menu.Items.Add('Exit tray')
$exit.Add_Click({ [System.Windows.Forms.Application]::Exit() })
$icon.ContextMenuStrip = $menu
$icon.Visible = $true
try { [System.Windows.Forms.Application]::Run() }
finally { $icon.Visible = $false; $icon.Dispose(); $menu.Dispose() }
