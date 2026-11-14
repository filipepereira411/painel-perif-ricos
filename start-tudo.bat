@echo off
rem Arranca o servidor e o agente em duas janelas.
rem O agente torna ESTE PC controlavel; o servidor serve o painel e o relay.
cd /d "%~dp0"

echo A abrir o servidor e o agente...
start "Servidor" cmd /c ""%~dp0server\start-servidor.bat""
timeout /t 2 >nul
start "Agente" cmd /c ""%~dp0agent\start-agent.bat""

echo.
echo Painel        : http://localhost:8080
echo Controlo remoto: http://localhost:8080/remoto.html
echo.
pause
