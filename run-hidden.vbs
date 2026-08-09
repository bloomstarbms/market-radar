' Launches Market Radar invisibly (no console window). Output goes to data\bot.log
Set shell = CreateObject("WScript.Shell")
shell.Run """" & CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName) & "\run-hidden.bat""", 0, False
