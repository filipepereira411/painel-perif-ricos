@echo off
title Servidor - Painel de Perifericos + Controlo Remoto
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao encontrado. Instala em https://nodejs.org ^(versao 22 ou mais recente^).
  pause
  exit /b 1
)

node -e "require.resolve('express')" >nul 2>nul
if errorlevel 1 (
  echo A instalar dependencias ^(express, ws^)...
  call npm install
  if errorlevel 1 (
    echo Falha na instalacao. Corre "npm install" dentro da pasta server.
    pause
    exit /b 1
  )
)

node server.js
pause
