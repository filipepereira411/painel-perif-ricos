@echo off
title Agente de Controlo Remoto
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao encontrado. Instala em https://nodejs.org ^(versao 22 ou mais recente^).
  pause
  exit /b 1
)

if not exist "config.json" (
  echo Falta o ficheiro config.json nesta pasta.
  echo.
  echo Abre o painel no browser ^(http://IP-DO-SERVIDOR:8080/remoto.html^),
  echo em "Quero ser controlado", descarrega o config.json e coloca-o aqui.
  echo.
  pause
  exit /b 1
)

echo A arrancar o agente... ^(Ctrl+C para parar^)
node agent.js
pause
