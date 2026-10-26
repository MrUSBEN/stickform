@echo off
title Stickform
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org and run this again. & pause & exit /b 1)
node "source\server\stickform-server.mjs"
if errorlevel 1 pause
