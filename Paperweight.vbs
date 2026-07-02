' Paperweight launcher — double-click to start the app.
' Runs Electron directly (no console window), as a NORMAL user.
' Important: do NOT "Run as administrator" — Windows blocks drag-and-drop
' from Explorer into elevated apps, and hides your mapped network drives.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
electronCmd = appDir & "\node_modules\.bin\electron.cmd"
If Not fso.FileExists(electronCmd) Then
  MsgBox "Electron is not installed yet." & vbCrLf & _
         "Open a terminal in this folder and run:  npm install", vbExclamation, "Paperweight"
  WScript.Quit
End If
sh.CurrentDirectory = appDir
sh.Run """" & electronCmd & """ .", 0, False
