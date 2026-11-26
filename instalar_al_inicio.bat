@echo off
chcp 65001 >nul
setlocal
title PASAARCHIVOS - arranque automatico

set "ACCESO=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\PASAARCHIVOS.lnk"

powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%ACCESO%'); $s.TargetPath='%~dp0iniciar_pasaarchivos.bat'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Description='PASAARCHIVOS - archivos en la red local'; $s.Save()"

if errorlevel 1 goto :error

echo.
echo   Listo: PASAARCHIVOS va a arrancar solo al iniciar sesion.
echo   Acceso creado en: %ACCESO%
echo.
echo   Para desactivarlo, borra ese acceso directo.
pause
exit /b 0

:error
echo.
echo   No pude crear el acceso directo.
pause
exit /b 1
