function Get-CdrOwnedProcessHandles {
    param($RootProcess)
    # Snapshot ancestry while the verified root is alive; pin each discovered PID
    # and reject entries whose creation time no longer matches the snapshot.
    [void]$RootProcess.Handle
    $inventory = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate)
    $owned = [Collections.Generic.List[object]]::new()
    $owned.Add($RootProcess)
    for ($i = 0; $i -lt $owned.Count; $i++) {
        $parent = $owned[$i]
        foreach ($entry in $inventory | Where-Object { $_.ParentProcessId -eq $parent.Id }) {
            if ($entry.ProcessId -eq $PID) { throw 'Force restart helper is inside the target process tree.' }
            $child = Get-Process -Id ([int]$entry.ProcessId) -ErrorAction SilentlyContinue
            if ($null -eq $child) { continue }
            try {
                [void]$child.Handle
                $started = $child.StartTime.ToUniversalTime()
                if ($started -lt $parent.StartTime.ToUniversalTime() -or
                    [math]::Abs(($started - $entry.CreationDate.ToUniversalTime()).Ticks) -gt 10) {
                    $child.Dispose(); continue
                }
                $owned.Add($child)
            } catch { $child.Dispose() }
        }
    }
    return ,$owned
}

