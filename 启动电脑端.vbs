' WebTranslator PC - silent launcher (no CMD window)
Set fso = CreateObject("Scripting.FileSystemObject")
Set ws = CreateObject("WScript.Shell")

projectDir = fso.GetParentFolderName(WScript.ScriptFullName)
electron = projectDir & "\node_modules\electron\dist\electron.exe"

If fso.FileExists(electron) Then
    ws.CurrentDirectory = projectDir
    ' 0 = hidden window; Electron is a GUI app, no console appears
    ws.Run """" & electron & """ .", 0, False
Else
    MsgBox "Electron component missing. Please check node_modules folder." & vbCrLf & _
           "Or use the browser mode bat instead.", 48, "WebTranslator"
End If
