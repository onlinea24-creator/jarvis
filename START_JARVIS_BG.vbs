Set WshShell = CreateObject("WScript.Shell") 
WshShell.CurrentDirectory = "C:\Users\Utente\TEST GPT HOME MADE\versione 008\JARVIS_ELECTRON_V1" 
WshShell.Run "cmd.exe /c npm start", 0, False
