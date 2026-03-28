@echo off
echo.
echo  Installing dependencies (first time only)...
call npm install
echo.
echo  Starting DAYWORK server...
node server.js
pause
