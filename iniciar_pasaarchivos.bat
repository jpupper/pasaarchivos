@echo off
chcp 65001 >nul
setlocal
title PASAARCHIVOS
cd /d "%~dp0"

netstat -ano | findstr /c:":5636 " | findstr /c:"LISTENING" >nul
if not errorlevel 1 goto :ya_corre

where node >nul 2>nul
if errorlevel 1 goto :sin_node

echo.
echo   PASAARCHIVOS - servidor de archivos local
echo   ------------------------------------------
echo   Carpeta de archivos: %~dp0files
echo   Abriendo http://localhost:5636 ...
echo.

start "" cmd /c "ping -n 3 127.0.0.1 >nul & start http://localhost:5636/"

node server.js
echo.
echo   El servidor se detuvo. Cerra esta ventana o volve a ejecutar el acceso directo.
pause
exit /b 0

:ya_corre
echo.
echo   PASAARCHIVOS ya esta corriendo. Abro el navegador...
start "" "http://localhost:5636/"
ping -n 4 127.0.0.1 >nul
exit /b 0

:sin_node
echo.
echo   No encontre Node.js en el PATH.
echo   Instalalo desde https://nodejs.org y volve a ejecutar este archivo.
pause
exit /b 1
