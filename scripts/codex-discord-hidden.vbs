Option Explicit
If WScript.Arguments.Count <> 2 Then WScript.Quit 64

Dim shell, command, result
Set shell = CreateObject("WScript.Shell")
command = Chr(34) & WScript.Arguments(0) & Chr(34) _
    & " -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand " _
    & WScript.Arguments(1)
' The GUI host hides the console before PowerShell starts. Waiting preserves
' the child exit code so Task Scheduler can still apply its retry policy.
result = shell.Run(command, 0, True)
WScript.Quit result
