Option Explicit
Dim shell, files, scriptPath, command, result
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
scriptPath = files.BuildPath(files.GetParentFolderName(WScript.ScriptFullName), "open-local.ps1")
command = "powershell.exe -NoLogo -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & scriptPath & """"
On Error Resume Next
result = shell.Run(command, 0, True)
If Err.Number <> 0 Then
    MsgBox "Could not start Research Studio. Please check the installation.", vbExclamation, "Research Studio"
    WScript.Quit 1
End If
WScript.Quit result
